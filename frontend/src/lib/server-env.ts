import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

const PLACEHOLDER_PATTERN =
	/^(?:change[-_ ]?me|your[-_ ]|example(?:\.com)?|placeholder|todo|xxx|<[^>]+>)$/i;

export class ServerConfigurationError extends Error {
	readonly code = "SERVER_CONFIGURATION_ERROR";

	constructor(variableName: string) {
		super(`Server configuration is missing or invalid: ${variableName}.`);
		this.name = "ServerConfigurationError";
	}
}

export type RuntimeEnv = CloudflareEnv & Record<string, unknown>;

export function getRuntimeEnv(): RuntimeEnv {
	try {
		return getCloudflareContext().env as RuntimeEnv;
	} catch {
		if (process.env.NODE_ENV !== "development") {
			throw new ServerConfigurationError("Cloudflare runtime");
		}

		return {} as RuntimeEnv;
	}
}

function readRequiredString(env: RuntimeEnv, name: keyof CloudflareEnv): string {
	const runtimeValue = env[name];
	const processValue = process.env[name];
	const value =
		typeof runtimeValue === "string" && runtimeValue.trim()
			? runtimeValue.trim()
			: processValue?.trim();

	if (!value || PLACEHOLDER_PATTERN.test(value)) {
		throw new ServerConfigurationError(String(name));
	}

	return value;
}

function readHttpsBaseUrl(env: RuntimeEnv): string {
	const value = readRequiredString(env, "INSTAGRAM_MEDIA_PUBLIC_BASE_URL");

	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase();
		const isLocalHostname =
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1" ||
			hostname.endsWith(".local");

		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			isLocalHostname
		) {
			throw new Error("invalid");
		}

		return url.toString().replace(/\/+$/, "");
	} catch {
		throw new ServerConfigurationError("INSTAGRAM_MEDIA_PUBLIC_BASE_URL");
	}
}

function readGraphApiVersion(env: RuntimeEnv): string {
	const value = readRequiredString(env, "INSTAGRAM_GRAPH_API_VERSION");
	if (!/^v\d+\.\d+$/.test(value)) {
		throw new ServerConfigurationError("INSTAGRAM_GRAPH_API_VERSION");
	}
	return value;
}

function readAdminEmails(env: RuntimeEnv): string[] {
	const value = readRequiredString(env, "INSTAGRAM_PUBLISH_ADMIN_EMAILS");
	const emails = value
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);

	if (
		emails.length === 0 ||
		emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
	) {
		throw new ServerConfigurationError("INSTAGRAM_PUBLISH_ADMIN_EMAILS");
	}

	return [...new Set(emails)];
}

export type InstagramRuntimeConfig = {
	accessToken: string;
	accountId: string;
	graphApiVersion: string;
	mediaBucket: R2Bucket;
	mediaPublicBaseUrl: string;
};

type EncryptedTokenRecord = {
	ciphertext: string;
	expiresAt: string;
	issuedAt: string;
	iv: string;
};

const TOKEN_RECORD_KEY = "internal-instagram-credentials/access-token.json";
const TOKEN_REFRESH_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ASSUMED_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

class TokenRefreshError extends Error {
	constructor(readonly transient: boolean) {
		super("Instagram token refresh failed.");
		this.name = "TokenRefreshError";
	}
}

function decodeBase64Key(value: string): Uint8Array {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
	} catch {
		throw new ServerConfigurationError("INSTAGRAM_TOKEN_ENCRYPTION_KEY");
	}
}

function encodeBase64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}

async function importTokenEncryptionKey(env: RuntimeEnv): Promise<CryptoKey> {
	const raw = decodeBase64Key(readRequiredString(env, "INSTAGRAM_TOKEN_ENCRYPTION_KEY"));
	if (raw.byteLength !== 32) {
		throw new ServerConfigurationError("INSTAGRAM_TOKEN_ENCRYPTION_KEY");
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(
	key: CryptoKey,
	token: string,
	issuedAt: Date,
	expiresAt: Date,
): Promise<EncryptedTokenRecord> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(token),
	);
	return {
		ciphertext: encodeBase64(new Uint8Array(encrypted)),
		expiresAt: expiresAt.toISOString(),
		issuedAt: issuedAt.toISOString(),
		iv: encodeBase64(iv),
	};
}

async function decryptToken(key: CryptoKey, record: EncryptedTokenRecord): Promise<string> {
	try {
		const iv = decodeBase64Key(record.iv);
		const ciphertext = decodeBase64Key(record.ciphertext);
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			key,
			ciphertext,
		);
		return new TextDecoder().decode(decrypted);
	} catch {
		throw new ServerConfigurationError("encrypted Instagram access token");
	}
}

async function refreshInstagramToken(token: string): Promise<{
	accessToken: string;
	expiresInSeconds: number;
}> {
	const url = new URL("https://graph.instagram.com/refresh_access_token");
	url.searchParams.set("grant_type", "ig_refresh_token");
	url.searchParams.set("access_token", token);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		const body = (await response.json().catch(() => null)) as {
			access_token?: unknown;
			expires_in?: unknown;
		} | null;
		if (!response.ok) {
			throw new TokenRefreshError(response.status === 429 || response.status >= 500);
		}
		if (
			typeof body?.access_token !== "string" ||
			body.access_token.length < 20 ||
			typeof body.expires_in !== "number" ||
			body.expires_in <= 0
		) {
			throw new TokenRefreshError(false);
		}
		return { accessToken: body.access_token, expiresInSeconds: body.expires_in };
	} catch (error) {
		if (error instanceof TokenRefreshError) throw error;
		throw new TokenRefreshError(true);
	} finally {
		clearTimeout(timeout);
	}
}

async function getManagedInstagramToken(
	env: RuntimeEnv,
	bucket: R2Bucket,
	refreshIfDue: boolean,
): Promise<string> {
	const bootstrapToken = readRequiredString(env, "INSTAGRAM_ACCESS_TOKEN");
	if (!refreshIfDue && !env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) return bootstrapToken;

	const encryptionKey = await importTokenEncryptionKey(env);
	const stored = await bucket.get(TOKEN_RECORD_KEY);
	let record: EncryptedTokenRecord;
	let token: string;

	if (stored) {
		try {
			record = await stored.json<EncryptedTokenRecord>();
			token = await decryptToken(encryptionKey, record);
		} catch {
			throw new ServerConfigurationError("encrypted Instagram access token");
		}
	} else {
		const now = new Date();
		record = await encryptToken(
			encryptionKey,
			bootstrapToken,
			now,
			new Date(now.getTime() + ASSUMED_TOKEN_LIFETIME_MS),
		);
		await bucket.put(TOKEN_RECORD_KEY, JSON.stringify(record), {
			httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
		});
		token = bootstrapToken;
	}

	if (!refreshIfDue) return token;
	const issuedAt = Date.parse(record.issuedAt);
	if (Number.isFinite(issuedAt) && Date.now() - issuedAt < TOKEN_REFRESH_AGE_MS) return token;

	try {
		const refreshed = await refreshInstagramToken(token);
		const now = new Date();
		const nextRecord = await encryptToken(
			encryptionKey,
			refreshed.accessToken,
			now,
			new Date(now.getTime() + refreshed.expiresInSeconds * 1000),
		);
		await bucket.put(TOKEN_RECORD_KEY, JSON.stringify(nextRecord), {
			httpMetadata: { cacheControl: "private, no-store", contentType: "application/json" },
		});
		return refreshed.accessToken;
	} catch (error) {
		console.error(
			JSON.stringify({
				code: "INSTAGRAM_TOKEN_REFRESH_FAILED",
				errorName: error instanceof Error ? error.name : "UnknownError",
				event: "instagram_token_refresh_failed",
			}),
		);
		if (
			error instanceof TokenRefreshError &&
			error.transient &&
			Date.parse(record.expiresAt) > Date.now()
		) {
			return token;
		}
		throw new ServerConfigurationError("INSTAGRAM_ACCESS_TOKEN");
	}
}

export async function getInstagramRuntimeConfig(options?: {
	refreshToken?: boolean;
}): Promise<InstagramRuntimeConfig> {
	const env = getRuntimeEnv();
	const mediaBucket = env.INSTAGRAM_MEDIA;

	if (!mediaBucket || typeof mediaBucket.put !== "function") {
		throw new ServerConfigurationError("INSTAGRAM_MEDIA");
	}

	return {
		accessToken: await getManagedInstagramToken(env, mediaBucket, options?.refreshToken === true),
		accountId: readRequiredString(env, "INSTAGRAM_ACCOUNT_ID"),
		graphApiVersion: readGraphApiVersion(env),
		mediaBucket,
		mediaPublicBaseUrl: readHttpsBaseUrl(env),
	};
}

export type AccessRuntimeConfig = {
	adminEmails: string[];
	audience: string;
	teamDomain: string;
};

export function getAccessRuntimeConfig(): AccessRuntimeConfig {
	const env = getRuntimeEnv();
	const rawTeamDomain = readRequiredString(env, "CLOUDFLARE_ACCESS_TEAM_DOMAIN");

	let teamDomain: string;
	try {
		const url = new URL(rawTeamDomain);
		if (
			url.protocol !== "https:" ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!url.hostname.endsWith(".cloudflareaccess.com")
		) {
			throw new Error("invalid");
		}
		teamDomain = url.origin;
	} catch {
		throw new ServerConfigurationError("CLOUDFLARE_ACCESS_TEAM_DOMAIN");
	}

	return {
		adminEmails: readAdminEmails(env),
		audience: readRequiredString(env, "CLOUDFLARE_ACCESS_AUD"),
		teamDomain,
	};
}

export function isLocalDevelopment(): boolean {
	return process.env.NODE_ENV === "development";
}
