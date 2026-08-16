// cache.ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeLog } from "./logger.js";
import type { McpCacheHints, McpResource, McpTool, MetadataCache, ServerCacheEntry } from "./types.js";

export function getCacheFilePath(): string {
	return join(getAgentDir(), "mcp-cache.json");
}
const CACHE_VERSION = 2 as const;
const DEFAULT_LEGACY_CACHE_TTL_MS = 5 * 60 * 1000;

let _memoryCache: MetadataCache | null = null;

function emptyCache(): MetadataCache {
	return { version: CACHE_VERSION, servers: {} };
}

function isValidEntry(value: unknown): value is ServerCacheEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		Array.isArray(entry.tools) &&
		Array.isArray(entry.resources) &&
		typeof entry.serverFingerprint === "string" &&
		typeof entry.ttlMs === "number" &&
		Number.isFinite(entry.ttlMs) &&
		entry.ttlMs >= 0 &&
		(entry.cacheScope === "public" || entry.cacheScope === "private") &&
		(entry.authorizationFingerprint === undefined || typeof entry.authorizationFingerprint === "string") &&
		typeof entry.receivedAt === "number" &&
		Number.isFinite(entry.receivedAt)
	);
}

function isValidCacheStructure(data: unknown): data is MetadataCache {
	if (data === null || typeof data !== "object") return false;
	const cache = data as Record<string, unknown>;
	if (cache.version !== CACHE_VERSION || cache.servers === null || typeof cache.servers !== "object") return false;
	return Object.values(cache.servers as Record<string, unknown>).every(isValidEntry);
}

function createPersistentCache(cache: MetadataCache, now = Date.now()): MetadataCache {
	return {
		version: CACHE_VERSION,
		servers: Object.fromEntries(
			Object.entries(cache.servers).flatMap(([serverName, entry]) => {
				if (entry.cacheScope !== "public" || entry.ttlMs <= 0 || now - entry.receivedAt >= entry.ttlMs) return [];
				return [
					[
						serverName,
						{
							tools: entry.tools,
							resources: entry.resources,
							serverFingerprint: entry.serverFingerprint,
							ttlMs: entry.ttlMs,
							cacheScope: entry.cacheScope,
							receivedAt: entry.receivedAt,
						},
					],
				];
			}),
		),
	};
}

function writeCacheFile(cache: MetadataCache): void {
	const cacheFilePath = getCacheFilePath();
	const tmpPath = `${cacheFilePath}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		const dir = dirname(cacheFilePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
		renameSync(tmpPath, cacheFilePath);
	} catch (err) {
		writeLog(`Failed to save metadata cache atomically: ${err}`, "ERROR");
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {}
	}
}

export function loadMetadataCache(): MetadataCache {
	if (_memoryCache) return _memoryCache;

	const cacheFilePath = getCacheFilePath();
	if (existsSync(cacheFilePath)) {
		try {
			const parsed = JSON.parse(readFileSync(cacheFilePath, "utf8"));
			if (isValidCacheStructure(parsed)) {
				_memoryCache = createPersistentCache(parsed);
				writeCacheFile(_memoryCache);
				return _memoryCache;
			}
			// Version 1 stored raw server definitions in `hash`; discard it rather than migrating secrets.
			writeLog("Discarding legacy or invalid MCP metadata cache.", "WARN");
		} catch (err) {
			writeLog(`Failed to parse metadata cache: ${err}`, "ERROR");
		}
	}

	_memoryCache = emptyCache();
	writeCacheFile(_memoryCache);
	return _memoryCache;
}

export function saveMetadataCache(cache: MetadataCache): void {
	_memoryCache = cache;
	writeCacheFile(createPersistentCache(cache));
}

export function updateServerCache(
	serverName: string,
	tools: McpTool[],
	resources: McpResource[],
	serverFingerprint: string,
	hints: McpCacheHints = {
		ttlMs: DEFAULT_LEGACY_CACHE_TTL_MS,
		cacheScope: "public",
		receivedAt: Date.now(),
	},
	authorizationFingerprint?: string,
): void {
	const cache = loadMetadataCache();
	cache.servers[serverName] = {
		tools,
		resources: resources || [],
		serverFingerprint,
		ttlMs: Math.max(0, hints.ttlMs),
		cacheScope: hints.cacheScope,
		receivedAt: hints.receivedAt,
		...(hints.cacheScope === "private" && authorizationFingerprint ? { authorizationFingerprint } : {}),
	};
	saveMetadataCache(cache);
}

export function getFreshServerCacheEntry(
	cache: MetadataCache,
	serverName: string,
	serverFingerprint: string,
	authorizationFingerprint?: string,
	now = Date.now(),
): ServerCacheEntry | undefined {
	const entry = cache.servers[serverName];
	if (!entry || entry.serverFingerprint !== serverFingerprint) return undefined;
	if (entry.cacheScope === "private" && entry.authorizationFingerprint !== authorizationFingerprint) return undefined;
	if (entry.ttlMs <= 0 || now - entry.receivedAt >= entry.ttlMs) return undefined;
	return entry;
}
