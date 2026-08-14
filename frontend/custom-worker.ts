import puppeteer from "@cloudflare/puppeteer";

import {
	claimAutomationJob,
	clearPendingAutomationJob,
	createPublicationJob,
	getZonedParts,
	readAutomationJob,
	readAutomationSettings,
	readPendingAutomationJob,
	releaseDailyAutomationLock,
	sanitizeAutomationText,
	signAutomationRun,
	updateAutomationJob,
	writeAutomationCapability,
	type AutomationCapability,
	type AutomationJob,
} from "./src/lib/instagram/automation-store";

// The OpenNext worker is generated before Wrangler bundles this entry point.
// @ts-expect-error Generated build artifact is intentionally absent from source control.
import openNextWorker from "./.open-next/worker.js";

type BrowserResult = {
	terminal?: unknown;
	state?: unknown;
	mediaId?: unknown;
	errorCode?: unknown;
	errorMessage?: unknown;
	retrySafe?: unknown;
	capability?: unknown;
};

function readRequiredEnv(env: CloudflareEnv, name: keyof CloudflareEnv): string {
	const value = env[name];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Missing automation configuration: ${String(name)}.`);
	}
	return value.trim();
}

function readApplicationOrigin(env: CloudflareEnv): string {
	const value = readRequiredEnv(env, "INSTACONTENT_PUBLIC_BASE_URL");
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("INSTACONTENT_PUBLIC_BASE_URL must be a public HTTPS origin.");
	}
	return url.origin;
}

function isCapability(value: unknown): value is AutomationCapability {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AutomationCapability>;
	return (
		typeof candidate.checkedAt === "string" &&
		typeof candidate.supported === "boolean" &&
		typeof candidate.video === "boolean" &&
		typeof candidate.audio === "boolean" &&
		typeof candidate.message === "string"
	);
}

async function runBrowserJob(env: CloudflareEnv, job: AutomationJob): Promise<void> {
	const bucket = env.INSTAGRAM_MEDIA;
	const claimedJob = await claimAutomationJob(bucket, job.runId);
	if (!claimedJob) return;
	job = claimedJob;
	const attempts = job.attempts;

	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
	try {
		const origin = readApplicationOrigin(env);
		const signature = await signAutomationRun(
			readRequiredEnv(env, "INSTAGRAM_AUTOMATION_SIGNING_KEY"),
			job.runId,
		);
		const accessClientId = readRequiredEnv(env, "CLOUDFLARE_ACCESS_SERVICE_CLIENT_ID");
		const accessClientSecret = readRequiredEnv(
			env,
			"CLOUDFLARE_ACCESS_SERVICE_CLIENT_SECRET",
		);
		browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600_000 });
		const page = await browser.newPage();
		await page.setRequestInterception(true);
		page.on("request", (interceptedRequest) => {
			const requestUrl = new URL(interceptedRequest.url());
			if (requestUrl.origin !== origin) {
				void interceptedRequest.continue().catch(() => {});
				return;
			}
			void interceptedRequest.continue({
				headers: {
					...interceptedRequest.headers(),
					"cf-access-client-id": accessClientId,
					"cf-access-client-secret": accessClientSecret,
					"x-instacontent-automation-run-id": job.runId,
					"x-instacontent-automation-signature": signature,
				},
			}).catch(() => {});
		});

		const url = new URL("/modi", origin);
		url.searchParams.set("automationRunId", job.runId);
		await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: 60_000 });
		await page.waitForFunction(
			() =>
				Boolean(
					(window as typeof window & {
						__modiAutomationResult?: { terminal?: boolean };
					}).__modiAutomationResult?.terminal,
				),
			{ polling: 500, timeout: 9 * 60_000 },
		);
		const result: BrowserResult = await page.evaluate(
			() =>
				(window as typeof window & { __modiAutomationResult?: BrowserResult })
					.__modiAutomationResult ?? {},
		);

		if (job.kind === "probe") {
			if (!isCapability(result.capability)) throw new Error("WebCodecs probe returned invalid data.");
			await writeAutomationCapability(bucket, result.capability);
			await updateAutomationJob(bucket, job.runId, {
				finishedAt: new Date().toISOString(),
				state: "probe_complete",
			});
			await clearPendingAutomationJob(bucket, job.runId);
			return;
		}

		if (result.state === "published" && typeof result.mediaId === "string") {
			await updateAutomationJob(bucket, job.runId, {
				finishedAt: new Date().toISOString(),
				mediaId: result.mediaId.slice(0, 128),
				state: "published",
			});
			await clearPendingAutomationJob(bucket, job.runId);
			return;
		}

		const state = result.state === "outcome_unknown" ? "outcome_unknown" : "failed";
		const latest = await readAutomationJob(bucket, job.runId);
		if (
			state === "failed" &&
			result.retrySafe === true &&
			!latest?.publicationStartedAt &&
			attempts < 2
		) {
			await updateAutomationJob(bucket, job.runId, {
				errorCode:
					typeof result.errorCode === "string"
						? sanitizeAutomationText(result.errorCode, "AUTOMATION_RENDER_FAILED", 100)
						: "AUTOMATION_RENDER_FAILED",
				errorMessage:
					typeof result.errorMessage === "string"
						? sanitizeAutomationText(result.errorMessage, "Automatic Reel rendering failed.")
						: "Automatic Reel rendering failed.",
				retrySafe: true,
				finishedAt: undefined,
				state: "queued",
			});
			return;
		}
		await updateAutomationJob(bucket, job.runId, {
			errorCode:
				typeof result.errorCode === "string"
					? sanitizeAutomationText(result.errorCode, "AUTOMATION_FAILED", 100)
					: "AUTOMATION_FAILED",
			errorMessage:
				typeof result.errorMessage === "string"
					? sanitizeAutomationText(result.errorMessage, "Automatic Reel publishing failed.")
					: "Automatic Reel publishing failed.",
			finishedAt: new Date().toISOString(),
			retrySafe: result.retrySafe === true,
			state,
		});
		if (state === "failed" && !latest?.publicationStartedAt) {
			await releaseDailyAutomationLock(bucket, latest ?? job);
		}
		await clearPendingAutomationJob(bucket, job.runId);
	} catch (error) {
		const latest = await readAutomationJob(bucket, job.runId);
		if (latest?.state === "published" || latest?.state === "outcome_unknown") {
			await clearPendingAutomationJob(bucket, job.runId);
			return;
		}
		const retryBeforePublication =
			job.kind === "publish" &&
			!latest?.publicationStartedAt &&
			attempts < 2 &&
			(latest?.state !== "failed" || latest.retrySafe === true);
		const publicationOutcomeUnknown = Boolean(latest?.publicationStartedAt);
		await updateAutomationJob(bucket, job.runId, {
			errorCode: publicationOutcomeUnknown
				? "AUTOMATION_OUTCOME_UNKNOWN"
				: "AUTOMATION_BROWSER_FAILED",
			errorMessage: publicationOutcomeUnknown
				? "Instagram publication may have completed. Check the account before retrying."
				: error instanceof Error
					? sanitizeAutomationText(error.message, "Background browser failed.")
					: "Background browser failed.",
			...(retryBeforePublication
				? { finishedAt: undefined, retrySafe: true, state: "queued" as const }
				: {
						finishedAt: new Date().toISOString(),
						retrySafe: false,
						state: publicationOutcomeUnknown
							? ("outcome_unknown" as const)
							: ("failed" as const),
					}),
		});
		if (!retryBeforePublication) await clearPendingAutomationJob(bucket, job.runId);
		if (!retryBeforePublication && !latest?.publicationStartedAt) {
			await releaseDailyAutomationLock(bucket, latest ?? job);
		}
		console.error(
			JSON.stringify({
				code: "AUTOMATION_BROWSER_FAILED",
				event: "instagram_automation_failed",
				runId: job.runId,
			}),
		);
	} finally {
		if (browser) await browser.close();
	}
}

async function runAutomationTick(env: CloudflareEnv, scheduledTime: number): Promise<void> {
	const pending = await readPendingAutomationJob(env.INSTAGRAM_MEDIA);
	if (pending) {
		if (pending.state === "queued") {
			if (
				pending.source === "scheduled" &&
				!(await readAutomationSettings(env.INSTAGRAM_MEDIA)).enabled
			) {
				await updateAutomationJob(env.INSTAGRAM_MEDIA, pending.runId, {
					errorCode: "AUTOMATION_DISABLED",
					errorMessage: "The scheduled run was canceled because automation is disabled.",
					finishedAt: new Date().toISOString(),
					state: "failed",
				});
				await releaseDailyAutomationLock(env.INSTAGRAM_MEDIA, pending);
				await clearPendingAutomationJob(env.INSTAGRAM_MEDIA, pending.runId);
				return;
			}
			await runBrowserJob(env, pending);
			return;
		}
		if (pending.state === "published" || pending.state === "outcome_unknown") {
			await clearPendingAutomationJob(env.INSTAGRAM_MEDIA, pending.runId);
			return;
		}
		if (pending.state === "failed") {
			if (!pending.publicationStartedAt && pending.retrySafe && pending.attempts < 2) {
				await updateAutomationJob(env.INSTAGRAM_MEDIA, pending.runId, {
					finishedAt: undefined,
					state: "queued",
				});
				return;
			}
			if (!pending.publicationStartedAt) {
				await releaseDailyAutomationLock(env.INSTAGRAM_MEDIA, pending);
			}
			await clearPendingAutomationJob(env.INSTAGRAM_MEDIA, pending.runId);
			return;
		}
		const stale = Date.now() - Date.parse(pending.updatedAt) > 16 * 60_000;
		if (!stale) return;
		if (!pending.publicationStartedAt && pending.attempts < 2) {
			await updateAutomationJob(env.INSTAGRAM_MEDIA, pending.runId, {
				finishedAt: undefined,
				state: "queued",
			});
			return;
		}
		await updateAutomationJob(env.INSTAGRAM_MEDIA, pending.runId, {
			errorCode: pending.publicationStartedAt
				? "AUTOMATION_OUTCOME_UNKNOWN"
				: "AUTOMATION_TIMED_OUT",
			errorMessage: pending.publicationStartedAt
				? "Instagram publication may have completed. Check the account before retrying."
				: "The background renderer timed out.",
			finishedAt: new Date().toISOString(),
			state: pending.publicationStartedAt ? "outcome_unknown" : "failed",
		});
		if (!pending.publicationStartedAt) {
			await releaseDailyAutomationLock(env.INSTAGRAM_MEDIA, pending);
		}
		await clearPendingAutomationJob(env.INSTAGRAM_MEDIA, pending.runId);
		return;
	}

	const settings = await readAutomationSettings(env.INSTAGRAM_MEDIA);
	if (!settings.enabled) return;
	const zoned = getZonedParts(new Date(scheduledTime), settings.timeZone);
	if (zoned.time !== settings.time) return;
	const job = await createPublicationJob(
		env.INSTAGRAM_MEDIA,
		settings,
		"scheduled",
		zoned.date,
		readRequiredEnv(env, "INSTAGRAM_ACCOUNT_ID"),
		true,
	);
	if (job) await runBrowserJob(env, job);
}

export default {
	fetch: openNextWorker.fetch,
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(runAutomationTick(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<CloudflareEnv>;

// Re-export OpenNext cache Durable Objects when they are enabled later.
// @ts-expect-error Generated build artifact is intentionally absent from source control.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
