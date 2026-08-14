import { NextResponse } from "next/server";

import {
	createPublicationJob,
	getZonedParts,
	queueProbeJob,
	readAutomationCapability,
	readAutomationSettings,
} from "@/lib/instagram/automation-store";
import { requireInstagramAdministrator } from "@/lib/instagram/access";
import { getRuntimeEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number) {
	return NextResponse.json({ error: { message } }, { status });
}

function hasText(value: unknown, minimumLength = 1): boolean {
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

export async function POST(request: Request) {
	try {
		await requireInstagramAdministrator(request);
	} catch {
		return jsonError("You are not authorized to run automation.", 403);
	}

	const env = getRuntimeEnv();
	const bucket = env.INSTAGRAM_MEDIA;
	if (!bucket || typeof bucket.get !== "function") {
		return jsonError("Automation storage is not configured.", 503);
	}
	if (
		!env.BROWSER ||
		!isValidPublicOrigin(env.INSTACONTENT_PUBLIC_BASE_URL) ||
		!hasText(env.CLOUDFLARE_ACCESS_SERVICE_CLIENT_ID) ||
		!hasText(env.CLOUDFLARE_ACCESS_SERVICE_CLIENT_SECRET) ||
		!hasText(env.INSTAGRAM_AUTOMATION_SIGNING_KEY, 32)
	) {
		return jsonError("Cloudflare browser automation is not fully configured.", 503);
	}

	let action: unknown;
	try {
		action = (await request.json() as { action?: unknown }).action;
	} catch {
		return jsonError("Choose a valid automation action.", 400);
	}

	const settings = await readAutomationSettings(bucket);
	if (action === "probe") {
		const job = await queueProbeJob(bucket, settings);
		if (!job) return jsonError("Another automation job is already queued.", 409);
		return NextResponse.json({ runId: job.runId, state: job.state }, { status: 202 });
	}

	if (action !== "publish") return jsonError("Choose a valid automation action.", 400);
	const capability = await readAutomationCapability(bucket);
	if (!capability?.supported) {
		return jsonError("Run the Cloudflare WebCodecs check before publishing.", 409);
	}
	const localDate = getZonedParts(new Date(), settings.timeZone).date;
	const accountId = env.INSTAGRAM_ACCOUNT_ID?.trim();
	if (!accountId) return jsonError("Instagram account configuration is missing.", 503);
	const job = await createPublicationJob(bucket, settings, "manual", localDate, accountId, true);
	if (!job) {
		return jsonError("A Reel is already queued or has already been attempted for this date.", 409);
	}
	return NextResponse.json({ runId: job.runId, state: job.state }, { status: 202 });
}
