import { NextResponse } from "next/server";

import {
	sanitizeAutomationText,
	updateAutomationJob,
	type AutomationJobState,
} from "@/lib/instagram/automation-store";
import { requireAutomationJob } from "@/lib/instagram/automation-access";
import { getRuntimeEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLIENT_STATES = new Set<AutomationJobState>([
	"probing",
	"rendering",
	"uploading_video",
	"preparing_reel",
	"instagram_processing",
	"publishing",
	"published",
	"failed",
	"outcome_unknown",
]);

function forbidden() {
	return NextResponse.json({ error: { message: "Automation job is not authorized." } }, { status: 403 });
}

export async function GET(request: Request) {
	try {
		const job = await requireAutomationJob(request);
		return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
	} catch {
		return forbidden();
	}
}

export async function PATCH(request: Request) {
	let authorized;
	try {
		authorized = await requireAutomationJob(request);
	} catch {
		return forbidden();
	}
	let body: {
		state?: unknown;
		mediaId?: unknown;
		errorCode?: unknown;
		errorMessage?: unknown;
		retrySafe?: unknown;
	};
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: { message: "Invalid job update." } }, { status: 400 });
	}
	if (typeof body.state !== "string" || !CLIENT_STATES.has(body.state as AutomationJobState)) {
		return NextResponse.json({ error: { message: "Invalid job state." } }, { status: 400 });
	}
	const state = body.state as AutomationJobState;
	const now = new Date().toISOString();
	const patch = {
		state,
		...(state === "preparing_reel" && !authorized.publicationStartedAt
			? { publicationStartedAt: now }
			: {}),
		...(["published", "failed", "outcome_unknown"].includes(state)
			? { finishedAt: now }
			: {}),
		...(typeof body.mediaId === "string" ? { mediaId: body.mediaId.slice(0, 128) } : {}),
		...(typeof body.errorCode === "string"
			? { errorCode: sanitizeAutomationText(body.errorCode, "AUTOMATION_FAILED", 100) }
			: {}),
		...(typeof body.errorMessage === "string"
			? { errorMessage: sanitizeAutomationText(body.errorMessage, "Automation failed.") }
			: {}),
		...(typeof body.retrySafe === "boolean" ? { retrySafe: body.retrySafe } : {}),
	};
	const bucket = getRuntimeEnv().INSTAGRAM_MEDIA;
	await updateAutomationJob(bucket, authorized.runId, patch);
	return NextResponse.json({ ok: true });
}
