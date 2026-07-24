import "server-only";

import {
	getAccessRuntimeConfig,
	isLocalDevelopment,
} from "@/lib/server-env";

const ACCESS_KEY_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 30;

type AccessJwtHeader = {
	alg?: unknown;
	kid?: unknown;
};

type AccessJwtPayload = {
	aud?: unknown;
	email?: unknown;
	exp?: unknown;
	iss?: unknown;
	nbf?: unknown;
};

type AccessJwk = JsonWebKey & {
	alg?: string;
	kid?: string;
	kty?: string;
	use?: string;
};

export class AuthorizationError extends Error {
	readonly code = "FORBIDDEN";

	constructor() {
		super("You are not authorized to publish to Instagram.");
		this.name = "AuthorizationError";
	}
}

function decodeBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
		Math.ceil(value.length / 4) * 4,
		"=",
	);
	const decoded = atob(padded);
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function hasAudience(claim: unknown, expected: string): boolean {
	return claim === expected ||
		(Array.isArray(claim) && claim.some((value) => value === expected));
}

async function fetchAccessKey(teamDomain: string, keyId: string): Promise<AccessJwk> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ACCESS_KEY_TIMEOUT_MS);

	try {
		const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new AuthorizationError();
		}

		const body = (await response.json()) as { keys?: unknown };
		if (!Array.isArray(body.keys)) {
			throw new AuthorizationError();
		}

		const key = body.keys.find((candidate): candidate is AccessJwk => {
			if (!candidate || typeof candidate !== "object") return false;
			const jwk = candidate as AccessJwk;
			return (
				jwk.kid === keyId &&
				jwk.kty === "RSA" &&
				jwk.alg === "RS256" &&
				jwk.use === "sig"
			);
		});

		if (!key) {
			throw new AuthorizationError();
		}

		return key;
	} finally {
		clearTimeout(timeout);
	}
}

export async function requireInstagramAdministrator(request: Request): Promise<string> {
	const requestHostname = new URL(request.url).hostname.toLowerCase();
	const isLocalRequest =
		requestHostname === "localhost" ||
		requestHostname === "127.0.0.1" ||
		requestHostname === "::1";

	if (isLocalDevelopment() && isLocalRequest) {
		return "local-development";
	}

	const config = getAccessRuntimeConfig();
	const token = request.headers.get("cf-access-jwt-assertion");
	if (!token) {
		throw new AuthorizationError();
	}

	try {
		const parts = token.split(".");
		if (parts.length !== 3) {
			throw new AuthorizationError();
		}

		const header = decodeJsonPart<AccessJwtHeader>(parts[0]);
		const payload = decodeJsonPart<AccessJwtPayload>(parts[1]);
		if (
			header.alg !== "RS256" ||
			typeof header.kid !== "string" ||
			payload.iss !== config.teamDomain ||
			!hasAudience(payload.aud, config.audience) ||
			typeof payload.exp !== "number" ||
			typeof payload.email !== "string"
		) {
			throw new AuthorizationError();
		}

		const now = Math.floor(Date.now() / 1000);
		if (
			payload.exp < now - CLOCK_SKEW_SECONDS ||
			(typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_SECONDS)
		) {
			throw new AuthorizationError();
		}

		const key = await fetchAccessKey(config.teamDomain, header.kid);
		const cryptoKey = await crypto.subtle.importKey(
			"jwk",
			key,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const validSignature = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			cryptoKey,
			decodeBase64Url(parts[2]),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
		const email = payload.email.trim().toLowerCase();

		if (!validSignature || !config.adminEmails.includes(email)) {
			throw new AuthorizationError();
		}

		return email;
	} catch {
		throw new AuthorizationError();
	}
}
