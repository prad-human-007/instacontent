import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

import {
	AuthorizationError,
	requireInstagramAdministrator,
} from "@/lib/instagram/access";
import {
	InstagramPublishingError,
	publishInstagramReel,
} from "@/lib/instagram/publisher";
import {
	getInstagramRuntimeConfig,
	ServerConfigurationError,
} from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_VIDEO_BYTES + 256 * 1024;
const MAX_CAPTION_LENGTH = 2_200;
const EXPORT_ID_PATTERN = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

type PublicationRecord = {
	createdAt: string;
	objectKey: string;
	publishedMediaId?: string;
	state:
		| "uploading"
		| "preparing"
		| "processing"
		| "publishing"
		| "published"
		| "failed"
		| "outcome_unknown";
	updatedAt: string;
};

type StreamEvent =
	| {
			type: "stage";
			stage:
				| "preparing_reel"
				| "instagram_processing"
				| "publishing";
	  }
	| { type: "published"; mediaId: string; duplicate?: boolean }
	| { type: "error"; code: string; message: string; retrySafe: boolean };

function jsonError(code: string, message: string, status: number) {
	return NextResponse.json(
		{ error: { code, message } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

function safePathSegment(value: string): string {
	return encodeURIComponent(value).replace(/%2F/gi, "");
}

function makePublicUrl(baseUrl: string, objectKey: string): string {
	const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
	const basePath = base.pathname.replace(/\/+$/, "");
	base.pathname = `${basePath}/${objectKey
		.split("/")
		.map(safePathSegment)
		.join("/")}`;
	return base.toString();
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function isMp4(file: Blob): Promise<boolean> {
	const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	return (
		header.length >= 12 &&
		header[4] === 0x66 &&
		header[5] === 0x74 &&
		header[6] === 0x79 &&
		header[7] === 0x70
	);
}

async function readRecord(
	bucket: R2Bucket,
	key: string,
): Promise<PublicationRecord | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		return await object.json<PublicationRecord>();
	} catch {
		return null;
	}
}

async function writeRecord(
	bucket: R2Bucket,
	key: string,
	record: PublicationRecord,
): Promise<void> {
	await bucket.put(key, JSON.stringify(record), {
		httpMetadata: {
			cacheControl: "private, no-store",
			contentType: "application/json",
		},
	});
}

function streamResponse(events: StreamEvent[], status = 200): Response {
	return new Response(
		events.map((event) => `${JSON.stringify(event)}\n`).join(""),
		{
			status,
			headers: {
				"cache-control": "no-store",
				"content-type": "application/x-ndjson; charset=utf-8",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

export async function POST(request: Request): Promise<Response> {
	try {
		await requireInstagramAdministrator(request);
	} catch (error) {
		if (error instanceof ServerConfigurationError) {
			return jsonError(error.code, error.message, 503);
		}
		if (error instanceof AuthorizationError) {
			return jsonError(error.code, error.message, 403);
		}
		return jsonError("FORBIDDEN", "You are not authorized to publish to Instagram.", 403);
	}

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
		return jsonError("INVALID_CONTENT_TYPE", "Expected an MP4 upload.", 415);
	}

	const contentLength = Number(request.headers.get("content-length"));
	if (
		Number.isFinite(contentLength) &&
		contentLength > MAX_REQUEST_BYTES
	) {
		return jsonError("VIDEO_TOO_LARGE", "The MP4 must be 64 MB or smaller.", 413);
	}

	let config;
	try {
		config = getInstagramRuntimeConfig();
	} catch (error) {
		if (error instanceof ServerConfigurationError) {
			return jsonError(error.code, error.message, 503);
		}
		return jsonError("SERVER_CONFIGURATION_ERROR", "Instagram publishing is not configured.", 503);
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return jsonError("INVALID_UPLOAD", "The upload could not be read.", 400);
	}

	const video = formData.get("video");
	const captionValue = formData.get("caption");
	const exportIdValue = formData.get("exportId");
	const caption = typeof captionValue === "string" ? captionValue.trim() : "";
	const exportId =
		typeof exportIdValue === "string" ? exportIdValue.trim().toLowerCase() : "";

	if (
		!video ||
		typeof video === "string" ||
		!video.name.toLowerCase().endsWith(".mp4") ||
		!video.type.toLowerCase().startsWith("video/mp4") ||
		video.size <= 0 ||
		video.size > MAX_VIDEO_BYTES ||
		!(await isMp4(video))
	) {
		return jsonError("INVALID_VIDEO", "Upload a valid MP4 no larger than 64 MB.", 400);
	}
	if (!caption || caption.length > MAX_CAPTION_LENGTH) {
		return jsonError(
			"INVALID_CAPTION",
			`Caption must contain 1 to ${MAX_CAPTION_LENGTH} characters.`,
			400,
		);
	}
	if (!EXPORT_ID_PATTERN.test(exportId)) {
		return jsonError("INVALID_EXPORT_ID", "The generated video identity is invalid.", 400);
	}

	const idempotencyDigest = await sha256Hex(
		`instagram-reel:${config.accountId}:${exportId}`,
	);
	const recordKey = `internal-publication-state/${idempotencyDigest}.json`;
	const objectKey = `temporary-instagram-media/${new Date()
		.toISOString()
		.slice(0, 10)}/${crypto.randomUUID()}.mp4`;
	const timestamp = new Date().toISOString();
	let record: PublicationRecord = {
		createdAt: timestamp,
		objectKey,
		state: "uploading",
		updatedAt: timestamp,
	};

	const lock = await config.mediaBucket.put(recordKey, JSON.stringify(record), {
		httpMetadata: {
			cacheControl: "private, no-store",
			contentType: "application/json",
		},
		onlyIf: new Headers({ "if-none-match": "*" }),
	});

	if (!lock) {
		const existing = await readRecord(config.mediaBucket, recordKey);
		if (existing?.state === "published" && existing.publishedMediaId) {
			return streamResponse([
				{
					type: "published",
					mediaId: existing.publishedMediaId,
					duplicate: true,
				},
			]);
		}
		return streamResponse(
			[
				{
					type: "error",
					code: "DUPLICATE_PUBLICATION",
					message: "This generated video already has a publication attempt.",
					retrySafe: false,
				},
			],
			409,
		);
	}

	try {
		await config.mediaBucket.put(objectKey, video.stream(), {
			httpMetadata: {
				cacheControl: "public, max-age=86400",
				contentDisposition: "inline",
				contentType: "video/mp4",
			},
			customMetadata: {
				exportId,
				purpose: "instagram-reel",
			},
		});
	} catch {
		record = { ...record, state: "failed", updatedAt: new Date().toISOString() };
		try {
			await writeRecord(config.mediaBucket, recordKey, record);
		} catch {
			console.error(
				JSON.stringify({
					code: "R2_STATE_WRITE_FAILED",
					event: "instagram_publish_failed",
				}),
			);
		}
		return jsonError("R2_UPLOAD_FAILED", "The video could not be stored for Instagram.", 502);
	}

	const videoUrl = makePublicUrl(config.mediaPublicBaseUrl, objectKey);
	const { ctx } = getCloudflareContext();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let streamOpen = true;
			const send = (event: StreamEvent) => {
				if (!streamOpen) return;
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				} catch {
					streamOpen = false;
				}
			};

			const task = (async () => {
				try {
					const mediaId = await publishInstagramReel(config, {
						caption,
						videoUrl,
						onStage(stage) {
							record = {
								...record,
								state:
									stage === "preparing_reel"
										? "preparing"
										: stage === "instagram_processing"
											? "processing"
											: "publishing",
								updatedAt: new Date().toISOString(),
							};
							send({ type: "stage", stage });
						},
					});
					record = {
						...record,
						publishedMediaId: mediaId,
						state: "published",
						updatedAt: new Date().toISOString(),
					};
					try {
						await writeRecord(config.mediaBucket, recordKey, record);
					} catch {
						console.error(
							JSON.stringify({
								code: "R2_STATE_WRITE_FAILED_AFTER_PUBLISH",
								event: "instagram_publish_failed",
							}),
						);
						send({
							type: "error",
							code: "PUBLISH_CONFIRMATION_WRITE_FAILED",
							message:
								"Instagram may have published the Reel. Check the account before trying again.",
							retrySafe: false,
						});
						return;
					}
					send({ type: "published", mediaId });
				} catch (error) {
					const publishError =
						error instanceof InstagramPublishingError
							? error
							: new InstagramPublishingError(
									"INSTAGRAM_PUBLISH_FAILED",
									"Instagram publishing failed.",
								);
					record = {
						...record,
						state:
							publishError.code === "META_PUBLISH_OUTCOME_UNKNOWN"
								? "outcome_unknown"
								: "failed",
						updatedAt: new Date().toISOString(),
					};
					try {
						await writeRecord(config.mediaBucket, recordKey, record);
					} catch {
						console.error(
							JSON.stringify({
								code: "R2_STATE_WRITE_FAILED",
								event: "instagram_publish_failed",
							}),
						);
					}
					console.error(
						JSON.stringify({
							code: publishError.code,
							event: "instagram_publish_failed",
						}),
					);
					send({
						type: "error",
						code: publishError.code,
						message: publishError.message,
						retrySafe: publishError.retrySafe,
					});
				} finally {
					if (streamOpen) {
						controller.close();
					}
				}
			})();

			ctx.waitUntil(task);
		},
	});

	return new Response(stream, {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/x-ndjson; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}
