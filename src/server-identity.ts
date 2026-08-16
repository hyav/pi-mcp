import { createHash } from "node:crypto";
import type { ServerDefinition } from "./types.js";

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		if (key === "_source") continue;
		const child = (value as Record<string, unknown>)[key];
		if (child !== undefined) result[key] = canonicalize(child);
	}
	return result;
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

/** In-memory identity for a concrete connection, including the resolved authorization context. */
export function getServerConnectionFingerprint(definition: ServerDefinition): string {
	return digest({
		definition,
		resolvedBearerToken: definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined,
	});
}

/** Non-secret identity safe to persist alongside public metadata. */
export function getServerCacheFingerprint(definition: ServerDefinition): string {
	return digest({
		command: definition.command,
		args: definition.args,
		cwd: definition.cwd,
		url: definition.url,
		type: definition.type,
		protocolMode: definition.protocolMode,
	});
}

export function getServerPoolKey(serverName: string, definition: ServerDefinition): string {
	return `${serverName}\0${getServerConnectionFingerprint(definition)}`;
}
