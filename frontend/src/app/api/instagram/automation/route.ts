import { NextResponse } from "next/server";

import {
	getNextRunAt,
	getZonedParts,
	hasDailyAutomationLock,
	readAutomationCapability,
	readAutomationSettings,
	readLastAutomationJob,
	readPendingAutomationJob,
	sanitizeAutomationText,
	type AutomationJob,
	validateAutomationSettings,
	writeAutomationSettings,
} from "@/lib/instagram/automation-store";
import {
	AuthorizationError,
	requireInstagramAdministrator,
} from "@/lib/instagram/access";
import { getRuntimeEnv, ServerConfigurationError } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number) {
	return NextResponse.json(
		{ error: { message } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

async function authorize(request: Request): Promise<Response | null> {
	try {
		await requireInstagramAdministrator(request);
		return null;
	} catch (error) {
		if (error instanceof ServerConfigurationError) return errorResponse(error.message, 503);
		if (error instanceof AuthorizationError) return errorResponse(error.message, 403);
		return errorResponse("You are not authorized to manage automation.", 403);
	}
}

function getBucket(): R2Bucket {
	const bucket = getRuntimeEnv().INSTAGRAM_MEDIA;
	if (!bucket || typeof bucket.get !== "function") {
		throw new ServerConfigurationError("INSTAGRAM_MEDIA");
	}
	return bucket;
}

function isValidEncryptionKey(value: unknown): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	try {
		const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).byteLength === 32;
	} catch {
		return false;
	}
}

function isConfiguredString(value: unknown, minimumLength = 1): boolean {
	return typeof value === "string" && value.trim().length >= minimumLength;
}

function isValidPublicOrigin(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value.trim());
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function summarizeJob(job: AutomationJob | null) {
	if (!job) return null;
	return {
		attempts: job.attempts,
		createdAt: job.createdAt,
		errorCode: job.errorCode
			? sanitizeAutomationText(job.errorCode, "AUTOMATION_FAILED", 100)
			: undefined,
		errorMessage: job.errorMessage
			? sanitizeAutomationText(job.errorMessage, "Automation failed.")
			: undefined,
		finishedAt: job.finishedAt,
		localDate: job.localDate,
		mediaId: job.mediaId,
		runId: job.runId,
		source: job.source,
		stageTimestamps: job.stageTimestamps,
		startedAt: job.startedAt,
		state: job.state,
		updatedAt: job.updatedAt,
	};
}

export async function GET(request: Request) {
	const denied = await authorize(request);
	if (denied) return denied;
	try {
		const bucket = getBucket();
		const [settings, capability, activeRun, lastRun] = await Promise.all([
			readAutomationSettings(bucket),
			readAutomationCapability(bucket),
			readPendingAutomationJob(bucket),
			readLastAutomationJob(bucket),
		]);
		const env = getRuntimeEnv();
		const localDate = getZonedParts(new Date(), settings.timeZone).date;
		const skipLocalDate =
			isConfiguredString(env.INSTAGRAM_ACCOUNT_ID) &&
			(await hasDailyAutomationLock(bucket, env.INSTAGRAM_ACCOUNT_ID.trim(), localDate))
				? localDate
				: undefined;
		return NextResponse.json(
			{
				settings,
				capability,
				activeRun: summarizeJob(activeRun),
				lastRun: summarizeJob(lastRun),
				nextRunAt: getNextRunAt(settings, new Date(), skipLocalDate),
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		return errorResponse(
			error instanceof Error ? error.message : "Automation status is unavailable.",
			503,
		);
	}
}

export async function PUT(request: Request) {
	const denied = await authorize(request);
	if (denied) return denied;
	try {
		const bucket = getBucket();
		const settings = validateAutomationSettings(await request.json());
		if (settings.enabled) {
			const capability = await readAutomationCapability(bucket);
			if (!capability?.supported) {
				return errorResponse("Run the Cloudflare WebCodecs check before enabling automation.", 409);
			}
			const env = getRuntimeEnv();
			if (
				!isConfiguredString(env.INSTAGRAM_AUTOMATION_SIGNING_KEY, 32) ||
				!isValidEncryptionKey(env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) ||
				!isConfiguredString(env.CLOUDFLARE_ACCESS_SERVICE_CLIENT_ID) ||
				!isConfiguredString(env.CLOUDFLARE_ACCESS_SERVICE_CLIENT_SECRET) ||
				!isValidPublicOrigin(env.INSTACONTENT_PUBLIC_BASE_URL) ||
				!isConfiguredString(env.INSTAGRAM_ACCOUNT_ID) ||
				!env.BROWSER
			) {
				return errorResponse("Cloudflare browser automation is not fully configured.", 503);
			}
		}
		await writeAutomationSettings(bucket, settings);
		const env = getRuntimeEnv();
		const localDate = getZonedParts(new Date(), settings.timeZone).date;
		const skipLocalDate =
			isConfiguredString(env.INSTAGRAM_ACCOUNT_ID) &&
			(await hasDailyAutomationLock(bucket, env.INSTAGRAM_ACCOUNT_ID.trim(), localDate))
				? localDate
				: undefined;
		return NextResponse.json({
			settings,
			nextRunAt: getNextRunAt(settings, new Date(), skipLocalDate),
		});
	} catch (error) {
		return errorResponse(
			error instanceof Error ? error.message : "Automation settings could not be saved.",
			400,
		);
	}
}
