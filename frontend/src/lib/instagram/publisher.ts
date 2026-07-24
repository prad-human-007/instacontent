import "server-only";

import type { InstagramRuntimeConfig } from "@/lib/server-env";

const GRAPH_API_BASE_URL = "https://graph.instagram.com";
const REQUEST_TIMEOUT_MS = 20_000;
const PROCESSING_TIMEOUT_MS = 4 * 60_000;
const INITIAL_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 15_000;

type PublishingStage =
	| "preparing_reel"
	| "instagram_processing"
	| "publishing";

type MetaErrorBody = {
	error?: {
		code?: unknown;
		error_subcode?: unknown;
		type?: unknown;
	};
};

export class InstagramPublishingError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retrySafe = false,
	) {
		super(message);
		this.name = "InstagramPublishingError";
	}
}

function getMetaErrorCode(body: unknown): string {
	const error = (body as MetaErrorBody | null)?.error;
	const code = typeof error?.code === "number" ? String(error.code) : "unknown";
	const subcode =
		typeof error?.error_subcode === "number"
			? `_${String(error.error_subcode)}`
			: "";
	return `${code}${subcode}`;
}

async function requestMetaJson(
	config: InstagramRuntimeConfig,
	path: string,
	init: RequestInit,
	failureCode: string,
	failureMessage: string,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${config.accessToken}`);
		const response = await fetch(
			`${GRAPH_API_BASE_URL}/${config.graphApiVersion}/${path}`,
			{
				...init,
				headers,
				signal: controller.signal,
			},
		);
		const body = await response.json().catch(() => null);

		if (!response.ok) {
			throw new InstagramPublishingError(
				`${failureCode}_${getMetaErrorCode(body)}`,
				failureMessage,
			);
		}

		return body;
	} catch (error) {
		if (error instanceof InstagramPublishingError) throw error;
		if (controller.signal.aborted) {
			throw new InstagramPublishingError(
				`${failureCode}_TIMEOUT`,
				"Instagram did not respond in time.",
			);
		}
		throw new InstagramPublishingError(
			`${failureCode}_NETWORK`,
			"Instagram could not be reached.",
		);
	} finally {
		clearTimeout(timeout);
	}
}

function readId(body: unknown, failureCode: string, message: string): string {
	const id = (body as { id?: unknown } | null)?.id;
	if (typeof id !== "string" || !/^\d+$/.test(id)) {
		throw new InstagramPublishingError(failureCode, message);
	}
	return id;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function publishInstagramReel(
	config: InstagramRuntimeConfig,
	input: {
		caption: string;
		videoUrl: string;
		onStage: (stage: PublishingStage) => void;
	},
): Promise<string> {
	input.onStage("preparing_reel");

	const createBody = new URLSearchParams({
		caption: input.caption,
		media_type: "REELS",
		share_to_feed: "true",
		video_url: input.videoUrl,
	});
	const createResponse = await requestMetaJson(
		config,
		`${encodeURIComponent(config.accountId)}/media`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: createBody,
		},
		"META_CONTAINER_CREATE_FAILED",
		"Instagram could not prepare this Reel.",
	);
	const containerId = readId(
		createResponse,
		"META_CONTAINER_ID_MISSING",
		"Instagram returned an invalid Reel container.",
	);

	input.onStage("instagram_processing");
	const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
	let pollDelay = INITIAL_POLL_DELAY_MS;
	let processingFinished = false;

	while (Date.now() < deadline) {
		const statusResponse = await requestMetaJson(
			config,
			`${encodeURIComponent(containerId)}?fields=status_code`,
			{ method: "GET" },
			"META_STATUS_FAILED",
			"Instagram could not report Reel processing status.",
		);
		const statusCode = (statusResponse as { status_code?: unknown } | null)
			?.status_code;

		if (statusCode === "FINISHED") {
			processingFinished = true;
			break;
		}
		if (statusCode === "ERROR") {
			throw new InstagramPublishingError(
				"META_PROCESSING_ERROR",
				"Instagram could not process this video.",
				true,
			);
		}
		if (statusCode === "EXPIRED") {
			throw new InstagramPublishingError(
				"META_CONTAINER_EXPIRED",
				"The Instagram Reel container expired before publishing.",
				true,
			);
		}
		if (statusCode !== "IN_PROGRESS") {
			throw new InstagramPublishingError(
				"META_UNKNOWN_STATUS",
				"Instagram returned an unknown processing state.",
			);
		}

		await delay(Math.min(pollDelay, Math.max(0, deadline - Date.now())));
		pollDelay = Math.min(pollDelay * 2, MAX_POLL_DELAY_MS);
	}

	if (!processingFinished) {
		throw new InstagramPublishingError(
			"META_PROCESSING_TIMEOUT",
			"Instagram did not finish processing the video in time.",
			true,
		);
	}

	input.onStage("publishing");
	const publishBody = new URLSearchParams({ creation_id: containerId });

	try {
		const publishResponse = await requestMetaJson(
			config,
			`${encodeURIComponent(config.accountId)}/media_publish`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: publishBody,
			},
			"META_PUBLISH_FAILED",
			"Instagram could not publish this Reel.",
		);

		return readId(
			publishResponse,
			"META_MEDIA_ID_MISSING",
			"Instagram published without returning a valid media ID.",
		);
	} catch {
		throw new InstagramPublishingError(
			"META_PUBLISH_OUTCOME_UNKNOWN",
			"Instagram publication outcome is unknown. Check the account before trying again.",
		);
	}
}
