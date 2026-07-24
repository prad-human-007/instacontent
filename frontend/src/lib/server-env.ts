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

type RuntimeEnv = CloudflareEnv & Record<string, unknown>;

function getRuntimeEnv(): RuntimeEnv {
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

export function getInstagramRuntimeConfig(): InstagramRuntimeConfig {
	const env = getRuntimeEnv();
	const mediaBucket = env.INSTAGRAM_MEDIA;

	if (!mediaBucket || typeof mediaBucket.put !== "function") {
		throw new ServerConfigurationError("INSTAGRAM_MEDIA");
	}

	return {
		accessToken: readRequiredString(env, "INSTAGRAM_ACCESS_TOKEN"),
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
