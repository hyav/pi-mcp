/**
 * Core type definitions for the pi-mcp-kit gateway.
 *
 * @module types
 */

/** Tracks which configuration file a server definition originated from. */
export type ConfigSource = "global" | "local" | "custom" | "third-party";

/**
 * Configuration for a single MCP server.
 *
 * Servers can be stdio-based (command + args) or HTTP-based (url + headers).
 *
 * @example
 * ```json
 * {
 *   "command": "npx",
 *   "args": ["-y", "@modelcontextprotocol/server-example"],
 *   "env": { "API_KEY": "${MY_API_KEY}" }
 * }
 * ```
 *
 * @example
 * ```json
 * {
 *   "url": "https://api.example.com/mcp",
 *   "type": "streamable-http",
 *   "headers": { "Authorization": "Bearer ${TOKEN}" }
 * }
 * ```
 */
export interface ServerDefinition {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "bearer";
	bearerToken?: string;
	bearerTokenEnv?: string;
	idleTimeout?: number; // In minutes, optional override
	initTimeout?: number; // In milliseconds, optional initialization timeout override
	debug?: boolean; // If true, logs all stderr streams inline
	type?: "sse" | "streamable-http";
	maxConcurrentRequests?: number; // Per-server concurrency limit, defaults to 5
	protocolMode?: "auto" | "legacy" | "modern"; // "auto"/undefined negotiates; legacy and modern force one mode
	_source?: ConfigSource; // Internal: tracks which config file this definition came from
}

/** Supported MCP protocol versions (newest first) */
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const LATEST_PROTOCOL_VERSION: McpProtocolVersion = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION: McpProtocolVersion = "2025-11-25";
export const FALLBACK_LEGACY_PROTOCOL_VERSION: McpProtocolVersion = "2024-11-05";

export interface McpExtensionDeclaration {
	[extensionId: string]: Record<string, unknown>;
}

/** Discovery result returned by server/discover RPC (2026-07-28 spec) */
export interface DiscoverResult {
	resultType: "complete";
	supportedVersions: McpProtocolVersion[];
	capabilities: Record<string, unknown>;
	instructions?: string;
	ttlMs?: number;
	cacheScope?: "public" | "private";
	_meta?: {
		"io.modelcontextprotocol/serverInfo"?: { name: string; version: string };
		[key: string]: unknown;
	};
}

/** Per-request metadata injected into params._meta (2026-07-28 spec) */
export interface McpRequestMeta {
	"io.modelcontextprotocol/protocolVersion": McpProtocolVersion;
	"io.modelcontextprotocol/clientCapabilities": {
		roots?: Record<string, unknown>;
		extensions?: McpExtensionDeclaration;
		[key: string]: unknown;
	};
	"io.modelcontextprotocol/clientInfo": { name: string; version: string };
	"io.modelcontextprotocol/logLevel"?:
		| "debug"
		| "info"
		| "notice"
		| "warning"
		| "error"
		| "critical"
		| "alert"
		| "emergency";
}

/** Multi Round-Trip Request: server needs additional input */
export interface InputRequiredResult {
	resultType: "input_required";
	inputRequests: Array<{
		name: string;
		description?: string;
		schema?: Record<string, unknown>;
	}>;
	requestState: string; // opaque token from server
}

/** Check if a tool result is an MRTR input-required response */
export function isInputRequired(result: unknown): result is InputRequiredResult {
	return typeof result === "object" && result !== null && (result as any).resultType === "input_required";
}

/**
 * Top-level MCP configuration structure.
 *
 * Loaded from `~/.pi/agent/mcp.json` (global), `.pi/mcp.json` (local),
 * and auto-discovered from third-party IDE configs.
 */
export interface McpConfig {
	/** Map of server name → server definition */
	mcpServers: Record<string, ServerDefinition>;
	/** Global settings overrides */
	settings?: {
		/** Minutes of inactivity before auto-closing a connection (default: 10, 0 = never) */
		idleTimeout?: number;
		/** Enable stderr passthrough for all servers */
		debug?: boolean;
		/** Enable scanning of local workspace `.mcp.json` files (requires trust API) */
		enableLocalConfig?: boolean;
		/** Import user-level Cursor/Claude MCP configurations (disabled by default) */
		enableThirdPartyConfig?: boolean;
	};
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: any; // JSON Schema
	readOnlyHint?: boolean;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
		title?: string;
	};
}

export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface McpCacheHints {
	ttlMs: number;
	cacheScope: "public" | "private";
	receivedAt: number;
}

export interface McpCachedList<T> extends McpCacheHints {
	items: T[];
}

export interface ServerCacheEntry extends McpCacheHints {
	tools: McpTool[];
	resources: McpResource[];
	serverFingerprint: string;
	/** In-memory only; private entries must match the exact credential context. */
	authorizationFingerprint?: string;
}

export interface MetadataCache {
	version: 2;
	servers: Record<string, ServerCacheEntry>;
}

/**
 * Structured error codes for all MCP gateway failures.
 *
 * Used with {@link McpError} to enable programmatic error handling
 * (e.g. session recovery on `SESSION_EXPIRED`).
 */
export const McpErrorCode = {
	UNKNOWN: "UNKNOWN",
	CONNECTION_FAILED: "CONNECTION_FAILED",
	CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
	UNAUTHORIZED: "UNAUTHORIZED",
	TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
	INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
	SERVER_CRASHED: "SERVER_CRASHED",
	CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
	SESSION_EXPIRED: "SESSION_EXPIRED",
	HEADER_MISMATCH: "HEADER_MISMATCH",
	MISSING_CAPABILITY: "MISSING_CAPABILITY",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	INPUT_REQUIRED: "INPUT_REQUIRED",
	REQUEST_CANCELLED: "REQUEST_CANCELLED",
} as const;

export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

/**
 * Structured error with a machine-readable {@link McpErrorCode}.
 *
 * Thrown by all client operations; pools and proxies inspect `code`
 * to decide whether to retry (timeout), recover (session expired),
 * or fast-fail (unauthorized).
 *
 * @example
 * ```ts
 * try {
 *   await client.callTool("search", { query: "..." });
 * } catch (err) {
 *   if (err instanceof McpError && err.code === McpErrorCode.SESSION_EXPIRED) {
 *     // trigger recovery
 *   }
 * }
 * ```
 */
export class McpError extends Error {
	/** Machine-readable error category */
	public readonly code: McpErrorCode;

	/**
	 * @param message Human-readable error description
	 * @param code Error category (defaults to `UNKNOWN`)
	 */
	constructor(message: string, code: McpErrorCode = McpErrorCode.UNKNOWN) {
		super(message);
		this.name = "McpError";
		this.code = code;
	}
}

/**
 * Unified proxy call arguments for tool execution and resource access.
 *
 * Supports auto-escape-free object arguments:
 * ```ts
 * { server: "bigquery", tool: "execute_sql", args: { sql: "SELECT 1" } }
 * ```
 */
export interface McpProxyArgs {
	server: string;
	tool?: string;
	toolDefinition?: McpTool;
	args?: Record<string, any>; // Declared as key-value pairs without nested JSON strings
	resourceList?: boolean; // List resources exposed by the server
	resourceRead?: string; // Read specified resource URI
}
