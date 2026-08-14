import { AUDIO_FILES, isAudioFile } from "../audio-manifest";

const SETTINGS_KEY = "internal-automation/settings.json";
const CAPABILITY_KEY = "internal-automation/capability.json";
const PENDING_KEY = "internal-automation/pending.json";
const LAST_RUN_KEY = "internal-automation/last-run.json";
const JOB_PREFIX = "internal-automation/jobs/";
const DAILY_PREFIX = "internal-automation/daily/";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const encoder = new TextEncoder();

export type AutomationSettings = {
	enabled: boolean;
	time: string;
	timeZone: string;
	startDate: string;
	endDate: string;
	audioFile: string;
	updatedAt: string;
};

export type AutomationCapability = {
	checkedAt: string;
	supported: boolean;
	video: boolean;
	audio: boolean;
	message: string;
};

export type AutomationJobKind = "probe" | "publish";
export type AutomationJobSource = "probe" | "manual" | "scheduled";
export type AutomationJobState =
	| "queued"
	| "probing"
	| "rendering"
	| "uploading_video"
	| "preparing_reel"
	| "instagram_processing"
	| "publishing"
	| "published"
	| "probe_complete"
	| "failed"
	| "outcome_unknown";

export type AutomationJob = {
	attempts: number;
	createdAt: string;
	errorCode?: string;
	errorMessage?: string;
	finishedAt?: string;
	kind: AutomationJobKind;
	localDate: string;
	mediaId?: string;
	publicationKey?: string;
	publicationStartedAt?: string;
	retrySafe?: boolean;
	runId: string;
	settings: AutomationSettings;
	source: AutomationJobSource;
	stageTimestamps?: Partial<Record<AutomationJobState, string>>;
	startedAt?: string;
	state: AutomationJobState;
	updatedAt: string;
};

type PendingJob = { runId: string };
type DailyLock = { runId: string };

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
	enabled: false,
	time: "12:00",
	timeZone: "Asia/Kolkata",
	startDate: "2024-06-09",
	endDate: "2029-06-09",
	audioFile: AUDIO_FILES[0],
	updatedAt: new Date(0).toISOString(),
};

function jobKey(runId: string): string {
	return `${JOB_PREFIX}${encodeURIComponent(runId)}.json`;
}

function dailyKey(publicationKey: string): string {
	return `${DAILY_PREFIX}${publicationKey}.json`;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function createAutomationPublicationKey(
	accountId: string,
	localDate: string,
): Promise<string> {
	return sha256Hex(`instagram-reel:${accountId}:${localDate}`);
}

export function sanitizeAutomationText(
	value: unknown,
	fallback: string,
	maximumLength = 500,
): string {
	if (typeof value !== "string") return fallback;
	const sanitized = value
		.replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
		.replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (sanitized || fallback).slice(0, maximumLength);
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const object = await bucket.get(key);
	if (!object) return null;
	try {
		return await object.json<T>();
	} catch {
		return null;
	}
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
	await bucket.put(key, JSON.stringify(value), {
		httpMetadata: {
			cacheControl: "private, no-store",
			contentType: "application/json",
		},
	});
}

export function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}

function isValidCalendarDate(value: unknown): value is string {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

export function validateAutomationSettings(value: unknown): AutomationSettings {
	if (!value || typeof value !== "object") throw new Error("Automation settings are invalid.");
	const input = value as Partial<AutomationSettings>;
	if (typeof input.enabled !== "boolean") throw new Error("Enabled must be true or false.");
	if (typeof input.time !== "string" || !TIME_PATTERN.test(input.time)) {
		throw new Error("Choose a valid publishing time.");
	}
	if (typeof input.timeZone !== "string" || !isValidTimeZone(input.timeZone)) {
		throw new Error("Choose a valid timezone.");
	}
	if (
		!isValidCalendarDate(input.startDate) ||
		!isValidCalendarDate(input.endDate) ||
		input.endDate <= input.startDate
	) {
		throw new Error("Choose a valid start and end date.");
	}
	if (!isAudioFile(input.audioFile)) throw new Error("Choose an available audio file.");

	return {
		enabled: input.enabled,
		time: input.time,
		timeZone: input.timeZone,
		startDate: input.startDate,
		endDate: input.endDate,
		audioFile: input.audioFile,
		updatedAt: new Date().toISOString(),
	};
}

export function getZonedParts(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return {
		date: `${values.year}-${values.month}-${values.day}`,
		time: `${values.hour}:${values.minute}`,
	};
}

export function getNextRunAt(
	settings: AutomationSettings,
	after = new Date(),
	skipLocalDate?: string,
): string | null {
	if (!settings.enabled) return null;
	const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
	for (let offset = 0; offset < 50 * 60; offset += 1) {
		const candidate = new Date(start + offset * 60_000);
		const zoned = getZonedParts(candidate, settings.timeZone);
		if (zoned.time === settings.time && zoned.date !== skipLocalDate) {
			return candidate.toISOString();
		}
	}
	return null;
}

export async function hasDailyAutomationLock(
	bucket: R2Bucket,
	accountId: string,
	localDate: string,
): Promise<boolean> {
	const publicationKey = await createAutomationPublicationKey(accountId, localDate);
	return Boolean(await bucket.head(dailyKey(publicationKey)));
}

export async function readAutomationSettings(bucket: R2Bucket): Promise<AutomationSettings> {
	return (await readJson<AutomationSettings>(bucket, SETTINGS_KEY)) ?? DEFAULT_AUTOMATION_SETTINGS;
}

export async function writeAutomationSettings(
	bucket: R2Bucket,
	settings: AutomationSettings,
): Promise<void> {
	await putJson(bucket, SETTINGS_KEY, settings);
}

export async function readAutomationCapability(
	bucket: R2Bucket,
): Promise<AutomationCapability | null> {
	return readJson<AutomationCapability>(bucket, CAPABILITY_KEY);
}

export async function writeAutomationCapability(
	bucket: R2Bucket,
	capability: AutomationCapability,
): Promise<void> {
	await putJson(bucket, CAPABILITY_KEY, capability);
}

export async function readAutomationJob(
	bucket: R2Bucket,
	runId: string,
): Promise<AutomationJob | null> {
	return readJson<AutomationJob>(bucket, jobKey(runId));
}

export async function writeAutomationJob(
	bucket: R2Bucket,
	job: AutomationJob,
): Promise<void> {
	await putJson(bucket, jobKey(job.runId), job);
	if (["published", "failed", "outcome_unknown"].includes(job.state)) {
		await putJson(bucket, LAST_RUN_KEY, { runId: job.runId });
	}
}

export async function updateAutomationJob(
	bucket: R2Bucket,
	runId: string,
	patch: Partial<AutomationJob>,
): Promise<AutomationJob | null> {
	const current = await readAutomationJob(bucket, runId);
	if (!current) return null;
	const updatedAt = new Date().toISOString();
	const next: AutomationJob = {
		...current,
		...patch,
		runId: current.runId,
		kind: current.kind,
		source: current.source,
		settings: current.settings,
		stageTimestamps: patch.state
			? { ...current.stageTimestamps, [patch.state]: updatedAt }
			: current.stageTimestamps,
		updatedAt,
	};
	await writeAutomationJob(bucket, next);
	return next;
}

export async function claimAutomationJob(
	bucket: R2Bucket,
	runId: string,
): Promise<AutomationJob | null> {
	const object = await bucket.get(jobKey(runId));
	if (!object) return null;
	let current: AutomationJob;
	try {
		current = await object.json<AutomationJob>();
	} catch {
		return null;
	}
	if (current.state !== "queued") return null;
	const timestamp = new Date().toISOString();
	const next: AutomationJob = {
		...current,
		attempts: current.attempts + 1,
		startedAt: current.startedAt ?? timestamp,
		state: current.kind === "probe" ? "probing" : "rendering",
		stageTimestamps: {
			...current.stageTimestamps,
			[current.kind === "probe" ? "probing" : "rendering"]: timestamp,
		},
		updatedAt: timestamp,
	};
	const claimed = await bucket.put(jobKey(runId), JSON.stringify(next), {
		httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
		onlyIf: { etagMatches: object.etag },
	});
	return claimed ? next : null;
}

export async function readPendingAutomationJob(bucket: R2Bucket): Promise<AutomationJob | null> {
	const pending = await readJson<PendingJob>(bucket, PENDING_KEY);
	if (!pending?.runId) return null;
	const job = await readAutomationJob(bucket, pending.runId);
	if (!job) await bucket.delete(PENDING_KEY);
	return job;
}

export async function clearPendingAutomationJob(bucket: R2Bucket, runId: string): Promise<void> {
	const pending = await readJson<PendingJob>(bucket, PENDING_KEY);
	if (pending?.runId === runId) await bucket.delete(PENDING_KEY);
}

export async function readLastAutomationJob(bucket: R2Bucket): Promise<AutomationJob | null> {
	const latest = await readJson<{ runId: string }>(bucket, LAST_RUN_KEY);
	if (!latest?.runId) return null;
	const job = await readAutomationJob(bucket, latest.runId);
	return job && ["published", "failed", "outcome_unknown"].includes(job.state) ? job : null;
}

export async function queueProbeJob(
	bucket: R2Bucket,
	settings: AutomationSettings,
): Promise<AutomationJob | null> {
	const timestamp = new Date().toISOString();
	const runId = `probe-${crypto.randomUUID()}`;
	const job: AutomationJob = {
		attempts: 0,
		createdAt: timestamp,
		kind: "probe",
		localDate: getZonedParts(new Date(), settings.timeZone).date,
		runId,
		settings,
		source: "probe",
		state: "queued",
		stageTimestamps: { queued: timestamp },
		updatedAt: timestamp,
	};
	await writeAutomationJob(bucket, job);
	let lock: R2Object | null;
	try {
		lock = await bucket.put(PENDING_KEY, JSON.stringify({ runId }), {
			httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
			onlyIf: { etagDoesNotMatch: "*" },
		});
	} catch (error) {
		await bucket.delete(jobKey(runId));
		throw error;
	}
	if (!lock) {
		await bucket.delete(jobKey(runId));
		return null;
	}
	return job;
}

export async function createPublicationJob(
	bucket: R2Bucket,
	settings: AutomationSettings,
	source: "manual" | "scheduled",
	localDate: string,
	accountId: string,
	queue: boolean,
): Promise<AutomationJob | null> {
	const runId = `publish-${localDate}-${crypto.randomUUID()}`;
	const publicationKey = await createAutomationPublicationKey(accountId, localDate);
	const dailyLock = await bucket.put(dailyKey(publicationKey), JSON.stringify({ runId } satisfies DailyLock), {
		httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
		onlyIf: { etagDoesNotMatch: "*" },
	});
	if (!dailyLock) return null;
	const timestamp = new Date().toISOString();
	const job: AutomationJob = {
		attempts: 0,
		createdAt: timestamp,
		kind: "publish",
		localDate,
		publicationKey,
		runId,
		settings: { ...settings, enabled: settings.enabled },
		source,
		state: "queued",
		stageTimestamps: { queued: timestamp },
		updatedAt: timestamp,
	};
	try {
		await writeAutomationJob(bucket, job);
	} catch (error) {
		await bucket.delete(dailyKey(publicationKey));
		throw error;
	}

	if (queue) {
		let pendingLock: R2Object | null;
		try {
			pendingLock = await bucket.put(PENDING_KEY, JSON.stringify({ runId }), {
				httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
				onlyIf: { etagDoesNotMatch: "*" },
			});
		} catch (error) {
			await Promise.all([
				bucket.delete(dailyKey(publicationKey)),
				bucket.delete(jobKey(runId)),
			]);
			throw error;
		}
		if (!pendingLock) {
			await Promise.all([
				bucket.delete(dailyKey(publicationKey)),
				bucket.delete(jobKey(runId)),
			]);
			return null;
		}
	}
	return job;
}

export async function releaseDailyAutomationLock(
	bucket: R2Bucket,
	job: AutomationJob,
): Promise<void> {
	if (job.kind !== "publish" || !job.publicationKey) return;
	const key = dailyKey(job.publicationKey);
	const lock = await readJson<DailyLock>(bucket, key);
	if (lock?.runId === job.runId) await bucket.delete(key);
}

export async function signAutomationRun(secret: string, runId: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(runId)));
	return btoa(String.fromCharCode(...signature))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export async function verifyAutomationRunSignature(
	secret: string,
	runId: string,
	signature: string,
): Promise<boolean> {
	const expected = await signAutomationRun(secret, runId);
	if (expected.length !== signature.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	}
	return difference === 0;
}
