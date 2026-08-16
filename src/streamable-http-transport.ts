// streamable-http-transport.ts
import { MAX_MCP_RESPONSE_BYTES, readBoundedResponseText, serializeBoundedMcpPayload } from "./bounded-response.js";
import { writeLog } from "./logger.js";
import type { TransportHooks } from "./stdio-transport.js";
import type { McpTool } from "./types.js";
import { type FALLBACK_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION } from "./types.js";

interface McpParamHeaderDefinition {
	name: string;
	path: string[];
	type: "string" | "integer" | "boolean";
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function createHttpHeaders(base?: Record<string, string>, extra?: Record<string, string>): Headers {
	const headers = new Headers(base);
	for (const [name, value] of Object.entries(extra ?? {})) {
		headers.set(name, value);
	}
	return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsMcpHeaderAnnotation(value: unknown, seen = new Set<object>()): boolean {
	if (!isRecord(value)) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Object.hasOwn(value, "x-mcp-header")) return true;
	return Object.values(value).some((child) => containsMcpHeaderAnnotation(child, seen));
}

function getMcpParamHeaderDefinitions(schema: unknown): McpParamHeaderDefinition[] {
	const definitions: McpParamHeaderDefinition[] = [];
	const seenNames = new Set<string>();
	let invalidReason: string | undefined;

	const visit = (node: unknown, path: string[]) => {
		if (!isRecord(node) || invalidReason) return;

		if (Object.hasOwn(node, "x-mcp-header")) {
			const name = node["x-mcp-header"];
			const type = node.type;
			if (path.length === 0) {
				invalidReason = "x-mcp-header must annotate a property";
			} else if (typeof name !== "string" || !name || !HTTP_TOKEN.test(name)) {
				invalidReason = `invalid x-mcp-header name ${JSON.stringify(name)}`;
			} else if (type !== "string" && type !== "integer" && type !== "boolean") {
				invalidReason = `x-mcp-header ${JSON.stringify(name)} must use string, integer, or boolean type`;
			} else if (seenNames.has(name.toLowerCase())) {
				invalidReason = `duplicate x-mcp-header name ${JSON.stringify(name)}`;
			} else {
				seenNames.add(name.toLowerCase());
				definitions.push({ name, path, type });
			}
		}

		const properties = node.properties;
		if (properties !== undefined) {
			if (!isRecord(properties)) {
				invalidReason = "properties must be an object";
				return;
			}
			for (const [propertyName, propertySchema] of Object.entries(properties)) {
				visit(propertySchema, [...path, propertyName]);
			}
		}

		for (const [key, child] of Object.entries(node)) {
			if (key !== "properties" && key !== "x-mcp-header" && containsMcpHeaderAnnotation(child)) {
				invalidReason = `x-mcp-header must be reachable through properties only`;
				return;
			}
		}
	};

	visit(schema, []);
	if (invalidReason) throw new Error(invalidReason);
	return definitions;
}

export function validateMcpToolHeaders(tool: McpTool): void {
	getMcpParamHeaderDefinitions(tool.inputSchema);
}

export function encodeMcpHeaderValue(value: string): string {
	const safe = value === "" || /^[!#-~](?:[ -~]*[!#-~])?$/.test(value);
	if (safe && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
	return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildMcpParamHeaders(tool: McpTool, args: Record<string, unknown>): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const definition of getMcpParamHeaderDefinitions(tool.inputSchema)) {
		let value: unknown = args;
		for (const key of definition.path) {
			value = isRecord(value) ? value[key] : undefined;
		}
		if (value === undefined || value === null) continue;

		let serialized: string;
		if (definition.type === "string") {
			if (typeof value !== "string")
				throw new Error(`MCP header parameter ${definition.path.join(".")} must be a string`);
			serialized = value;
		} else if (definition.type === "boolean") {
			if (typeof value !== "boolean")
				throw new Error(`MCP header parameter ${definition.path.join(".")} must be a boolean`);
			serialized = String(value);
		} else {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) {
				throw new Error(`MCP header parameter ${definition.path.join(".")} must be a safe integer`);
			}
			serialized = String(value);
		}
		headers[`Mcp-Param-${definition.name}`] = encodeMcpHeaderValue(serialized);
	}
	return headers;
}

function parseSseEvent(event: string): unknown {
	const dataLines: string[] = [];
	for (const line of event.split(/\r\n|\r|\n/)) {
		if (line.startsWith("event:") && line.slice(6).trim().toLowerCase() !== "message") return undefined;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return undefined;
	try {
		return JSON.parse(dataLines.join("\n"));
	} catch {
		return undefined;
	}
}

function takeSseEvents(buffer: string): { events: string[]; rest: string } {
	const events: string[] = [];
	let rest = buffer;
	while (true) {
		const boundary = /\r\n\r\n|\n\n|\r\r/.exec(rest);
		if (!boundary || boundary.index === undefined) return { events, rest };
		events.push(rest.slice(0, boundary.index));
		rest = rest.slice(boundary.index + boundary[0].length);
	}
}

function findSseResponse(sseText: string, requestId: unknown, onMessage: (response: any) => void): any {
	const { events } = takeSseEvents(`${sseText}\n\n`);
	for (const event of events) {
		const parsed = parseSseEvent(event) as any;
		if (!parsed) continue;
		if (parsed.id === requestId) return parsed;
		onMessage(parsed);
	}
	return null;
}

async function readRequestSseResponse(
	response: Response,
	requestId: unknown,
	onMessage: (response: any) => void,
): Promise<any | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let totalBytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				buffer += decoder.decode();
				const final = findSseResponse(buffer, requestId, onMessage);
				return final;
			}
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_MCP_RESPONSE_BYTES) {
				await reader.cancel("response too large").catch(() => {});
				throw new Error(
					`PAYLOAD_TOO_LARGE: HTTP response exceeds the ${MAX_MCP_RESPONSE_BYTES}-byte safety limit.`,
				);
			}
			buffer += decoder.decode(value, { stream: true });
			const extracted = takeSseEvents(buffer);
			buffer = extracted.rest;
			for (const event of extracted.events) {
				const parsed = parseSseEvent(event) as any;
				if (!parsed) continue;
				if (parsed.id === requestId) {
					await reader.cancel("final response received").catch(() => {});
					return parsed;
				}
				onMessage(parsed);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * MCP transport over Streamable HTTP (MCP spec 2026-07-28 / 2025-03-26).
 *
 * **Protocol flow:**
 * 1. Modern 2026-07-28 requests use POST only; each request receives a JSON or request-scoped SSE response
 * 2. Legacy Streamable HTTP revisions may use GET for a long-lived SSE stream and session IDs
 * 3. The 2026-07-28 transport uses MRTR results instead of server-initiated JSON-RPC requests
 * 4. Legacy 404 responses can trigger session recovery
 */
export class StreamableHttpTransport {
	/** Session ID — used in legacy mode */
	private sessionId: string | null = null;
	private abortController: AbortController | null = null;
	private hooks: TransportHooks | null = null;
	private isClosed = false;

	/** Protocol mode: "legacy" or "modern" */
	public protocolMode: "legacy" | "modern" = "modern";

	/** Protocol version carried in modern request metadata and headers. */
	public protocolVersion: typeof LATEST_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

	/** Protocol version header used by legacy Streamable HTTP requests. */
	public legacyProtocolVersion: typeof LEGACY_PROTOCOL_VERSION | typeof FALLBACK_LEGACY_PROTOCOL_VERSION =
		LEGACY_PROTOCOL_VERSION;

	private serverName: string;
	private url: string;
	private headers?: Record<string, string>;
	readonly debug: boolean;
	private connectTimeoutMs: number;

	constructor(
		serverName: string,
		url: string,
		headers?: Record<string, string>,
		debug = false,
		connectTimeoutMs = 15_000,
	) {
		this.serverName = serverName;
		this.url = url;
		this.headers = headers;
		this.debug = debug;
		this.connectTimeoutMs = connectTimeoutMs;
	}

	async connect(hooks: TransportHooks, signal?: AbortSignal): Promise<any> {
		signal?.throwIfAborted();
		this.hooks = hooks;
		this.isClosed = false;
		this.abortController = new AbortController();

		writeLog(`[${this.serverName}] Establishing Streamable HTTP connection to: ${this.url}`, "INFO");

		if (this.protocolMode === "modern") {
			writeLog(`[${this.serverName}] Using POST-only Streamable HTTP for ${LATEST_PROTOCOL_VERSION}`, "INFO");
			return null;
		}

		// Earlier Streamable HTTP revisions used a standalone GET SSE stream.
		let timedOut = false;
		const onAbort = () => this.abortController?.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutId = setTimeout(() => {
			timedOut = true;
			this.abortController?.abort(new Error("Streamable HTTP connection timed out"));
		}, this.connectTimeoutMs);
		try {
			const sseHeaders = createHttpHeaders(this.headers);
			sseHeaders.set("Accept", "text/event-stream");
			sseHeaders.set("Mcp-Protocol-Version", this.legacyProtocolVersion);
			if (this.protocolMode === "legacy" && this.sessionId) {
				sseHeaders.set("Mcp-Session-Id", this.sessionId);
			}

			const response = await fetch(this.url, {
				headers: sseHeaders,
				signal: this.abortController.signal,
			});

			if (response.status === 405) {
				writeLog(`[${this.serverName}] GET returned 405, falling back to POST-only stateless mode`, "INFO");
			} else if (response.ok) {
				if (this.protocolMode === "legacy") {
					const getSessionId = response.headers.get("Mcp-Session-Id");
					if (getSessionId) {
						this.sessionId = getSessionId;
						writeLog(`[${this.serverName}] Discovered Mcp-Session-Id from GET`, "INFO");
					}
				}

				// Start reading SSE stream in background (if body is present)
				if (response.body) {
					this.readSseStream(response.body.getReader());
				} else {
					writeLog(`[${this.serverName}] GET returned 200 but no body, SSE streaming disabled`, "WARN");
				}
			}
		} catch (err: any) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
			if (timedOut) {
				throw new Error(
					`Connection timeout: failed to reach ${this.url} within ${Math.ceil(this.connectTimeoutMs / 1000)} seconds.`,
				);
			}
			// Non-fatal: a legacy server may not support GET; rely on POST responses
			writeLog(`[${this.serverName}] Legacy GET attempt failed: ${err.message}. Proceeding POST-only.`, "WARN");
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}

		return null; // actual init result comes via request()
	}

	private async readSseStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!this.isClosed) {
				const { value, done } = await reader.read();
				if (done) {
					if (!this.isClosed) {
						this.isClosed = true;
						this.hooks?.onExit("Streamable HTTP GET stream ended");
					}
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_RESPONSE_BYTES) {
					await reader.cancel("SSE event too large");
					throw new Error("PAYLOAD_TOO_LARGE: SSE event exceeds the 10MB safety limit.");
				}
				const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/);
				buffer = parts.pop() || "";

				for (const chunk of parts) {
					if (chunk.trim()) {
						this.parseEvent(chunk);
					}
				}
			}
		} catch (err: any) {
			if (!this.isClosed) {
				writeLog(`[${this.serverName}] Streamable HTTP stream error: ${err.message}`, "WARN");
				this.isClosed = true;
				this.hooks?.onExit(`Streamable HTTP stream error: ${err.message}`);
			}
		}
	}

	private parseEvent(chunk: string) {
		const lines = chunk.split("\n");
		let eventName = "message";
		const dataLines: string[] = [];

		for (const line of lines) {
			if (line.startsWith("event:")) {
				eventName = line.substring(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.substring(5).trim());
			}
		}

		if (eventName === "message" && dataLines.length > 0) {
			const dataContent = dataLines.join("\n");
			try {
				const response = JSON.parse(dataContent);
				this.hooks?.onMessage(response);
			} catch (err) {
				writeLog(`[${this.serverName}] Failed to parse JSON from Streamable HTTP event: ${err}`, "ERROR");
			}
		}
	}

	async send(
		payload: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<any | null> {
		const serializedPayload = serializeBoundedMcpPayload(payload);
		const postHeaders = createHttpHeaders(this.headers, extraHeaders);
		postHeaders.set("Content-Type", "application/json");
		postHeaders.set("Accept", "application/json, text/event-stream");
		postHeaders.set(
			"Mcp-Protocol-Version",
			this.protocolMode === "modern" ? this.protocolVersion : this.legacyProtocolVersion,
		);

		if (this.protocolMode === "modern") {
			const method = payload.method as string;
			if (method) postHeaders.set("Mcp-Method", method);
			const params = payload.params as Record<string, unknown> | undefined;
			if (params) {
				const name = params.name ?? params.uri;
				if (name && typeof name === "string") {
					postHeaders.set("Mcp-Name", encodeMcpHeaderValue(name));
				}
			}
		}

		if (this.protocolMode === "legacy" && this.sessionId) {
			postHeaders.set("Mcp-Session-Id", this.sessionId);
		}

		const res = await fetch(this.url, {
			method: "POST",
			headers: postHeaders,
			body: serializedPayload,
			signal,
		});

		if (this.protocolMode === "legacy") {
			const postSessionId = res.headers.get("Mcp-Session-Id");
			if (postSessionId && postSessionId !== this.sessionId) {
				this.sessionId = postSessionId;
				writeLog(`[${this.serverName}] Updated Mcp-Session-Id from POST`, "INFO");
			}
		}

		if (res.status === 200) {
			const contentType = res.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				return readRequestSseResponse(res, payload.id, (response) => this.hooks?.onMessage(response));
			}

			const text = await readBoundedResponseText(res);
			if (!text) return null;
			if (contentType.includes("application/json")) {
				try {
					return JSON.parse(text);
				} catch {
					writeLog(`[${this.serverName}] Failed to parse JSON response`, "ERROR");
					return null;
				}
			}

			// Unknown content-type: try JSON first, then a completed SSE body.
			try {
				return JSON.parse(text);
			} catch {
				return findSseResponse(text, payload.id, (response) => this.hooks?.onMessage(response));
			}
		}

		if (res.status === 202) {
			if (this.protocolMode === "modern") {
				throw new Error(
					"Modern Streamable HTTP request unexpectedly returned 202 Accepted without a response stream",
				);
			}
			return null; // Legacy response will arrive via the standalone SSE stream
		}

		if (res.status === 400 || res.status === 404) {
			const body = await readBoundedResponseText(res);
			if (body) {
				try {
					const parsed = JSON.parse(body);
					const code = parsed.error?.code;
					if (typeof code === "number") {
						const prefix =
							code === -32020
								? "[HEADER_MISMATCH]"
								: code === -32021
									? "[MISSING_CAPABILITY]"
									: code === -32022
										? "[UNSUPPORTED_VERSION]"
										: `[${code}]`;
						const error = new Error(`${prefix} ${parsed.error?.message || "MCP HTTP request failed"}`);
						(error as Error & { code?: number; supportedVersions?: unknown }).code = code;
						(error as Error & { code?: number; supportedVersions?: unknown }).supportedVersions =
							parsed.error?.data?.supported ?? parsed.error?.data?.supportedVersions;
						throw error;
					}
				} catch (error) {
					if (error instanceof Error && "code" in error) throw error;
				}
			}

			if (res.status === 404 && this.protocolMode === "legacy" && this.sessionId) {
				throw new Error(`[SESSION_EXPIRED] ${res.status} ${res.statusText}`);
			}
			if (res.status === 404 && this.protocolMode === "modern") {
				throw new Error("Streamable HTTP endpoint returned 404 without a JSON-RPC error");
			}
		}

		if (res.status === 401 || res.status === 403) {
			throw new Error(`[UNAUTHORIZED] ${res.status} ${res.statusText}`);
		}

		throw new Error(`Streamable HTTP POST error: ${res.status} ${res.statusText}`);
	}

	async sendNotification(payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const serializedPayload = serializeBoundedMcpPayload(payload);
		const postHeaders = createHttpHeaders(this.headers);
		postHeaders.set("Content-Type", "application/json");
		postHeaders.set("Accept", "application/json, text/event-stream");
		postHeaders.set(
			"Mcp-Protocol-Version",
			this.protocolMode === "modern" ? this.protocolVersion : this.legacyProtocolVersion,
		);

		if (this.protocolMode === "modern") {
			const method = payload.method as string;
			if (method) postHeaders.set("Mcp-Method", method);
		}

		if (this.protocolMode === "legacy" && this.sessionId) {
			postHeaders.set("Mcp-Session-Id", this.sessionId);
		}

		const res = await fetch(this.url, {
			method: "POST",
			headers: postHeaders,
			body: serializedPayload,
			signal,
		});

		if (this.protocolMode === "legacy") {
			const postSessionId = res.headers.get("Mcp-Session-Id");
			if (postSessionId && postSessionId !== this.sessionId) {
				this.sessionId = postSessionId;
			}
		}

		if (res.status !== 200 && res.status !== 202) {
			const body = await readBoundedResponseText(res).catch(() => "");
			throw new Error(
				`Streamable HTTP notification error: ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`,
			);
		}
	}

	async close(): Promise<void> {
		if (this.isClosed) return;
		this.isClosed = true;

		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}
}
