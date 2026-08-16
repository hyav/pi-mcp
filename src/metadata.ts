import { updateServerCache } from "./cache.js";
import type { SimpleMcpClient } from "./client.js";
import { getServerCacheFingerprint, getServerConnectionFingerprint } from "./server-identity.js";
import type { McpCacheHints, McpResource, McpTool, ServerDefinition } from "./types.js";

export interface RefreshedServerMetadata {
	tools: McpTool[];
	resources: McpResource[];
	cache: McpCacheHints;
}

export async function refreshServerMetadata(
	serverName: string,
	definition: ServerDefinition,
	client: SimpleMcpClient,
	signal?: AbortSignal,
): Promise<RefreshedServerMetadata> {
	const toolsResult = await client.listToolsWithMetadata(signal);
	let resourcesResult: Awaited<ReturnType<SimpleMcpClient["listResourcesWithMetadata"]>> | undefined;
	try {
		resourcesResult = await client.listResourcesWithMetadata(signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		// Resources are optional; a tools-only server can still refresh successfully.
	}

	const receivedAt = Date.now();
	const expirations = [
		toolsResult.receivedAt + toolsResult.ttlMs,
		...(resourcesResult ? [resourcesResult.receivedAt + resourcesResult.ttlMs] : []),
	];
	const cache: McpCacheHints = {
		receivedAt,
		ttlMs: Math.max(0, Math.min(...expirations) - receivedAt),
		cacheScope:
			toolsResult.cacheScope === "private" || resourcesResult?.cacheScope === "private" ? "private" : "public",
	};
	const resources = resourcesResult?.items ?? [];
	updateServerCache(
		serverName,
		toolsResult.items,
		resources,
		getServerCacheFingerprint(definition),
		cache,
		cache.cacheScope === "private" ? getServerConnectionFingerprint(definition) : undefined,
	);
	return { tools: toolsResult.items, resources, cache };
}
