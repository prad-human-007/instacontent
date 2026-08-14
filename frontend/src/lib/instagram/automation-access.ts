import "server-only";

import {
	readAutomationJob,
	verifyAutomationRunSignature,
	type AutomationJob,
} from "@/lib/instagram/automation-store";
import { getRuntimeEnv, ServerConfigurationError } from "@/lib/server-env";

export async function requireAutomationJob(request: Request): Promise<AutomationJob> {
	const env = getRuntimeEnv();
	const bucket = env.INSTAGRAM_MEDIA;
	if (!bucket || typeof bucket.get !== "function") {
		throw new ServerConfigurationError("INSTAGRAM_MEDIA");
	}
	const secret = env.INSTAGRAM_AUTOMATION_SIGNING_KEY?.trim();
	if (!secret || secret.length < 32) {
		throw new ServerConfigurationError("INSTAGRAM_AUTOMATION_SIGNING_KEY");
	}
	const runId = request.headers.get("x-instacontent-automation-run-id")?.trim() ?? "";
	const signature = request.headers.get("x-instacontent-automation-signature")?.trim() ?? "";
	if (!runId || !signature || !(await verifyAutomationRunSignature(secret, runId, signature))) {
		throw new Error("AUTOMATION_FORBIDDEN");
	}
	const job = await readAutomationJob(bucket, runId);
	if (!job) throw new Error("AUTOMATION_FORBIDDEN");
	return job;
}
