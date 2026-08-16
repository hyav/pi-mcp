// client.ts

import { createRequire } from "node:module";
import { writeLog } from "./logger.js";
import { SseTransport } from "./sse-transport.js";
import { StdioTransport } from "./stdio-transport.js";
import { buildMcpParamHeaders, StreamableHttpTransport, validateMcpToolHeaders } from "./streamable-http-transport.js";
import type {
	DiscoverResult,
	InputRequiredResult,
	McpCachedList,
	McpCacheHints,
	McpExtensionDeclaration,
	McpRequestMeta,
	McpResource,
	McpTool,
	ServerDefinition,
} from "./types.js";
import {
	FALLBACK_LEGACY_PROTOCOL_VERSION,
	isInputRequired,
	LATEST_PROTOCOL_VERSION,
	LEGACY_PROTOCOL_VERSION,
	McpError,
	McpErrorCode,
} from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 5;
const MAX_CONNECT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;
/** Absolute upper bound for a full session recovery cycle (close + reconnect). */
const RECOVERY_ABSOLUTE_TIMEOUT_MS = 30_000;

/** Resolve bearer token from server definition */
function resolveBearerToken(def: ServerDefinition): string | undefined {
	if (def.bearerToken) return def.bearerToken;
	if (def.bearerTokenEnv) return process.env[def.bearerTokenEnv];
	return undefined;
}

type McpTransport = StdioTransport | SseTransport | StreamableHttpTransport;

/**
 * Generic MCP client: manages JSON-RPC request/response matching,
 * concurrency, timeouts, and session recovery.
 *
 * Delegates transport-specific I/O to one of {@link StdioTransport},
 * {@link SseTransport}, or {@link StreamableHttpTransport}.
 *
 * **Lifecycle:**
 * 1. Instantiate with server config (command or url)
 * 2. `await client.connect()` — performs MCP initialize handshake or modern stateless probe
 * 3. `await client.callTool(name, args)` or `listTools()` etc.
 * 4. `await client.close()`
 *
 * **Session recovery:** Streamable HTTP servers that return 404
 * (session expired) trigger automatic reconnect + retry.
 *
 * @example
 * ```ts
 * const client = new SimpleMcpClient("my-server", "npx", ["-y", "my-package"]);
 * await client.connect();
 * const tools = await client.listTools();
 * const result = await client.callTool("search", { query: "hello" });
 * await client.close();
 * ```
 */
export class SimpleMcpClient {
	/** Human-readable server identifier (shown in logs and debug output) */
	public readonly name: string;

	/**
	 * Callback invoked when the underlying process or connection
	 * terminates unexpectedly. The {@link McpClientPool} uses this
	 * to remove stale entries from its internal map.
	 */
	public onExit?: () => void;

	/** Callback for MRTR: server needs user/agent input */
	public onInputRequired?: (
		toolName: string,
		inputRequests: InputRequiredResult["inputRequests"],
	) => Promise<Record<string, unknown>[]>;

	/** Server metadata populated during modern discover / handshake */
	public serverCapabilities?: Record<string, unknown>;
	public serverInstructions?: string;
	public serverInfo?: { name: string; version: string };
	public serverExtensions?: Record<string, unknown>;

	private transport: McpTransport | null = null;
	private requestId = 0;
	private pendingRequests = new Map<
		number,
		{
			resolve: (val: any) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			abortController: AbortController;
			removeAbortListener?: () => void;
		}
	>();
	private isClosed = false;
	private inFlight = 0;
	private maxConcurrentRequests: number;
	private requestQueue: Array<{
		method: string;
		params: any;
		timeoutMs: number;
		isRetry: boolean;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		removeAbortListener?: () => void;
		resolve: (val: any) => void;
		reject: (err: Error) => void;
	}> = [];

	private _protocolMode: "legacy" | "modern" = "modern";
	private _protocolVersion: typeof LATEST_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
	private _legacyProtocolVersion: typeof LEGACY_PROTOCOL_VERSION | typeof FALLBACK_LEGACY_PROTOCOL_VERSION =
		LEGACY_PROTOCOL_VERSION;
	private _requestedProtocolMode?: "auto" | "legacy" | "modern";
	private _extensions?: McpExtensionDeclaration;

	private static readonly CLIENT_INFO = {
		name: "pi-mcp",
		version: pkg.version || "1.0.0",
	};

	// Stored for session recovery on 404
	private _recoveryPromise: Promise<void> | null = null;
	private _command?: string;
	private _args: string[] = [];
	private _env?: Record<string, string>;
	private _cwd?: string;
	private _url?: string;
	private _headers?: Record<string, string>;
	private _debug = false;
	private _type?: "sse" | "streamable-http";
	private _initTimeoutMs?: number;

	constructor(
		name: string,
		command?: string,
		args: string[] = [],
		env?: Record<string, string>,
		url?: string,
		headers?: Record<string, string>,
		debug = false,
		type?: "sse" | "streamable-http",
		_initTimeoutMs?: number,
		cwd?: string,
		maxConcurrentRequests?: number,
		protocolMode?: "auto" | "legacy" | "modern",
	) {
		this.name = name;
		this.maxConcurrentRequests = maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;

		// Store for session recovery
		this._command = command;
		this._args = args;
		this._env = env;
		this._cwd = cwd;
		this._url = url;
		this._headers = headers;
		this._debug = debug;
		this._type = type;
		this._initTimeoutMs = _initTimeoutMs;
		this._requestedProtocolMode = protocolMode;

		this.transport = this._createTransport();
	}

	/** Create the appropriate transport based on stored config */
	private _createTransport(): McpTransport {
		const resolvedHeaders = this._headers ? { ...this._headers } : undefined;
		if (this._url) {
			if (this._type === "streamable-http") {
				const httpTransport = new StreamableHttpTransport(
					this.name,
					this._url,
					resolvedHeaders,
					this._debug,
					this._initTimeoutMs,
				);
				httpTransport.protocolMode = this._protocolMode;
				httpTransport.protocolVersion = this._protocolVersion;
				httpTransport.legacyProtocolVersion = this._legacyProtocolVersion;
				return httpTransport;
			}
			return new SseTransport(this.name, this._url, resolvedHeaders, this._debug, this._initTimeoutMs);
		}
		if (this._command) {
			return new StdioTransport(this.name, this._command, this._args, this._env, this._cwd, this._debug);
		}
		throw new McpError(`Cannot create transport: no url or command configured`, McpErrorCode.CONNECTION_FAILED);
	}

	private applyTransportProtocol(): void {
		if (this.transport instanceof StreamableHttpTransport) {
			this.transport.protocolMode = this._protocolMode;
			this.transport.protocolVersion = this._protocolVersion;
			this.transport.legacyProtocolVersion = this._legacyProtocolVersion;
		}
	}

	/** Register extensions supported by this client */
	public setExtensions(extensions: McpExtensionDeclaration): void {
		this._extensions = extensions;
	}

	/** Inject bearer token after construction (called by pool). Persists for session recovery. */
	setBearerToken(token: string): void {
		// Store in _headers for recovery
		if (!this._headers) this._headers = {};
		this._headers.Authorization = `Bearer ${token}`;

		// Apply to current transport if HTTP-based
		if (this.transport instanceof SseTransport || this.transport instanceof StreamableHttpTransport) {
			const t = this.transport as any;
			if (!t.headers) t.headers = {};
			t.headers.Authorization = `Bearer ${token}`;
		}
	}

	/**
	 * Inject _meta into request params for 2026-07-28 stateless protocol.
	 * Legacy mode skips injection.
	 */
	private injectMeta(params: Record<string, unknown>): Record<string, unknown> {
		if (this._protocolMode === "legacy") return params;
		const meta: McpRequestMeta = {
			...((params._meta as Record<string, unknown>) ?? {}),
			"io.modelcontextprotocol/protocolVersion": this._protocolVersion,
			"io.modelcontextprotocol/clientCapabilities": {
				...(params._meta && typeof (params._meta as any)["io.modelcontextprotocol/clientCapabilities"] === "object"
					? (params._meta as any)["io.modelcontextprotocol/clientCapabilities"]
					: {}),
				...(this._extensions ? { extensions: this._extensions } : {}),
			},
			"io.modelcontextprotocol/clientInfo": SimpleMcpClient.CLIENT_INFO,
		};
		if (this._debug) {
			meta["io.modelcontextprotocol/logLevel"] = "debug";
		}
		return {
			...params,
			_meta: meta,
		};
	}

	/**
	 * Perform server discovery via server/discover RPC (2026-07-28 spec).
	 * Stores capability and version info on client instance.
	 */
	public async discover(timeoutMs?: number, signal?: AbortSignal): Promise<DiscoverResult> {
		const timeout = timeoutMs ?? this._initTimeoutMs ?? 15_000;
		const result = (await this.request("server/discover", {}, timeout, undefined, signal)) as DiscoverResult;
		if (result) {
			if (Array.isArray(result.supportedVersions) && !result.supportedVersions.includes(this._protocolVersion)) {
				throw new McpError(
					`MCP server "${this.name}" does not support ${this._protocolVersion}. Supported versions: ${result.supportedVersions.join(", ")}`,
					McpErrorCode.UNSUPPORTED_VERSION,
				);
			}
			if (result.capabilities) this.serverCapabilities = result.capabilities;
			if (result.instructions) this.serverInstructions = result.instructions;
			if (result._meta?.["io.modelcontextprotocol/serverInfo"]) {
				this.serverInfo = result._meta["io.modelcontextprotocol/serverInfo"];
			}
			if (result.capabilities?.extensions) {
				this.serverExtensions = result.capabilities.extensions as Record<string, unknown>;
			}
		}
		return result;
	}

	async connect(signal?: AbortSignal): Promise<any> {
		if (!this.transport) {
			throw new McpError(
				`MCP Server "${this.name}" has neither "command" nor "url" configured.`,
				McpErrorCode.CONNECTION_FAILED,
			);
		}

		this.isClosed = false;
		this.inFlight = 0;

		if (this._requestedProtocolMode === "legacy") {
			this._protocolMode = "legacy";
		} else {
			// Modern mode is also the probe mode used for auto-detection.
			this._protocolMode = "modern";
		}
		this.applyTransportProtocol();

		await this.transport.connect(
			{
				onMessage: (response: any) => this.handleResponse(response),
				onExit: (reason: string) => {
					if (this.isClosed) return;
					this.isClosed = true;
					const err = new McpError(reason, McpErrorCode.SERVER_CRASHED);
					this.cleanupPendingRequests(err);
					if (this.onExit) {
						try {
							this.onExit();
						} catch {
							/* intentionally swallow */
						}
					}
				},
			},
			signal,
		);
		if (signal?.aborted) {
			throw new McpError(`Connection to MCP server "${this.name}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED);
		}

		if (this._requestedProtocolMode === "legacy") {
			return this._legacyHandshake(signal);
		}
		if (this._requestedProtocolMode === "modern") {
			return null;
		}

		return this._autoDetectProtocol(signal);
	}

	/** Legacy handshake: initialize → initialized (2024-11-05 / 2025-11-25) */
	private async _legacyHandshake(signal?: AbortSignal): Promise<any> {
		const initTimeout = this._initTimeoutMs ?? 15_000;
		this._legacyProtocolVersion = LEGACY_PROTOCOL_VERSION;
		this.applyTransportProtocol();
		try {
			const initResult = await this.request(
				"initialize",
				{
					protocolVersion: LEGACY_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: SimpleMcpClient.CLIENT_INFO,
				},
				initTimeout,
				undefined,
				signal,
			);

			await this.notification("notifications/initialized", {}, signal);
			return initResult;
		} catch (err: any) {
			if (signal?.aborted) throw err;
			writeLog(
				`[${this.name}] Legacy handshake with ${LEGACY_PROTOCOL_VERSION} failed, retrying with ${FALLBACK_LEGACY_PROTOCOL_VERSION}...`,
				"WARN",
			);
			this._legacyProtocolVersion = FALLBACK_LEGACY_PROTOCOL_VERSION;
			this.applyTransportProtocol();
			const initResult = await this.request(
				"initialize",
				{
					protocolVersion: FALLBACK_LEGACY_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: SimpleMcpClient.CLIENT_INFO,
				},
				initTimeout,
				undefined,
				signal,
			);

			await this.notification("notifications/initialized", {}, signal);
			return initResult;
		}
	}

	/** Probe server/discover first; any ordinary probe error identifies a legacy server. */
	private async _autoDetectProtocol(signal?: AbortSignal): Promise<any> {
		this._protocolMode = "modern";
		this.applyTransportProtocol();
		try {
			const discoverResult = await this.discover(undefined, signal);
			writeLog(`[${this.name}] Modern protocol (${LATEST_PROTOCOL_VERSION}) detected via server/discover`, "INFO");
			return discoverResult;
		} catch (err: any) {
			if (signal?.aborted) throw err;
			const msg = err.message || "";
			const code = err.code ?? (err.cause as any)?.code;

			// These are recognized modern-protocol errors, not evidence of a legacy server.
			if (code === -32020 || code === -32021) throw err;
			if (code === -32022) {
				const supportedVersions = (err as any).data?.supported ?? (err as any).supportedVersions;
				if (Array.isArray(supportedVersions) && supportedVersions.includes(LATEST_PROTOCOL_VERSION)) {
					throw err;
				}
				return this._fallbackToLegacy(signal);
			}

			if (msg.includes("-32022") || msg.includes("initialize") || code === -32022) {
				return this._fallbackToLegacy(signal);
			}

			// Parse error or JSON-RPC formatting issue on stdio/http also triggers legacy fallback
			return this._fallbackToLegacy(signal);
		}
	}

	private async _fallbackToLegacy(signal?: AbortSignal): Promise<any> {
		writeLog(`[${this.name}] Falling back to legacy protocol (${LEGACY_PROTOCOL_VERSION})`, "INFO");
		this._protocolMode = "legacy";
		this._legacyProtocolVersion = LEGACY_PROTOCOL_VERSION;
		this.applyTransportProtocol();
		return this._legacyHandshake(signal);
	}

	private releasePending(id: number) {
		const handler = this.pendingRequests.get(id);
		if (!handler) return undefined;
		clearTimeout(handler.timer);
		handler.removeAbortListener?.();
		this.pendingRequests.delete(id);
		this._decrementInFlight();
		return handler;
	}

	private notifyCancellation(id: number, reason: string): void {
		if (!this.transport) return;
		if (this.transport instanceof StreamableHttpTransport && this._protocolMode === "modern") return;
		this.transport
			.sendNotification({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, reason },
			})
			.catch((error) => {
				writeLog(`[${this.name}] Failed to send cancellation for request ${id}: ${error}`, "WARN");
			});
	}

	private cancelPending(id: number, error: McpError, reason: string): void {
		const handler = this.releasePending(id);
		if (!handler) return;
		handler.abortController.abort(reason);
		this.notifyCancellation(id, reason);
		handler.reject(error);
	}

	private handleResponse(response: any) {
		if (response.id === undefined || response.id === null) return;
		// Each JSON-RPC peer owns its own request-id space, so an inbound server
		// request can legitimately use the same numeric id as one of our requests.
		if (response.method) {
			writeLog(
				`[${this.name}] Received bidirectional request from server: ${response.method} (id: ${response.id})`,
				"WARN",
			);
			this.transport
				?.sendNotification({
					jsonrpc: "2.0",
					id: response.id,
					error: { code: -32601, message: `Method '${response.method}' not supported by client` },
				})
				.catch((err) => {
					writeLog(`[${this.name}] Failed to send error response to server: ${err.message}`, "ERROR");
				});
			return;
		}

		const handler = this.releasePending(response.id);
		if (!handler) return;
		if (response.error) {
			const codeStr = response.error.code !== undefined ? `[${response.error.code}] ` : "";
			const err = new Error(`${codeStr}${response.error.message || "Unknown MCP Error"}`);
			(err as any).code = response.error.code;
			(err as any).data = response.error.data;
			handler.reject(err);
		} else {
			handler.resolve(response.result);
		}
	}

	request(
		method: string,
		params: any,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
		extraHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<any> {
		return this._requestWithRetry(method, params, timeoutMs, false, extraHeaders, signal);
	}

	private _decrementInFlight() {
		this.inFlight = Math.max(0, this.inFlight - 1);
		this._processQueue();
	}

	private _processQueue() {
		if (this._recoveryPromise) return;
		if (this.isClosed) {
			while (this.requestQueue.length > 0) {
				const req = this.requestQueue.shift()!;
				req.removeAbortListener?.();
				req.reject(new McpError(`MCP server "${this.name}" is closed.`, McpErrorCode.CONNECTION_FAILED));
			}
			return;
		}
		while (this.inFlight < this.maxConcurrentRequests && this.requestQueue.length > 0) {
			const req = this.requestQueue.shift()!;
			req.removeAbortListener?.();
			this._executeRequest(
				req.method,
				req.params,
				req.timeoutMs,
				req.isRetry,
				req.headers,
				req.signal,
				req.resolve,
				req.reject,
			);
		}
	}

	private _requestWithRetry(
		method: string,
		params: any,
		timeoutMs: number,
		isRetry: boolean,
		extraHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<any> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new McpError(`MCP request "${method}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED));
				return;
			}
			if (this.isClosed || !this.transport) {
				reject(new McpError(`MCP server "${this.name}" is closed.`, McpErrorCode.CONNECTION_FAILED));
				return;
			}

			if (this.inFlight >= this.maxConcurrentRequests) {
				const queued: (typeof this.requestQueue)[number] = {
					method,
					params,
					timeoutMs,
					isRetry,
					headers: extraHeaders,
					signal,
					resolve,
					reject,
				};
				if (signal) {
					const onAbort = () => {
						const index = this.requestQueue.indexOf(queued);
						if (index >= 0) this.requestQueue.splice(index, 1);
						reject(new McpError(`MCP request "${method}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED));
					};
					signal.addEventListener("abort", onAbort, { once: true });
					queued.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				}
				this.requestQueue.push(queued);
				return;
			}

			this._executeRequest(method, params, timeoutMs, isRetry, extraHeaders, signal, resolve, reject);
		});
	}

	private waitForRecovery(promise: Promise<void>, method: string, signal?: AbortSignal): Promise<void> {
		if (!signal) return promise;
		const cancellation = () =>
			new McpError(`MCP request "${method}" was cancelled during session recovery.`, McpErrorCode.REQUEST_CANCELLED);
		if (signal.aborted) return Promise.reject(cancellation());
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(cancellation());
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	private _executeRequest(
		method: string,
		params: any,
		timeoutMs: number,
		isRetry: boolean,
		extraHeaders: Record<string, string> | undefined,
		signal: AbortSignal | undefined,
		resolve: (val: any) => void,
		reject: (err: Error) => void,
	) {
		if (signal?.aborted) {
			reject(new McpError(`MCP request "${method}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED));
			return;
		}

		const id = ++this.requestId;
		const abortController = new AbortController();
		this.inFlight++;
		const timer = setTimeout(() => {
			this.cancelPending(
				id,
				new McpError(`MCP server "${this.name}" request timed out.`, McpErrorCode.CONNECTION_TIMEOUT),
				`Request timed out after ${timeoutMs}ms`,
			);
		}, timeoutMs);
		const handler = { resolve, reject, timer, abortController } as typeof this.pendingRequests extends Map<
			any,
			infer V
		>
			? V
			: never;
		if (signal) {
			const onAbort = () => {
				this.cancelPending(
					id,
					new McpError(`MCP request "${method}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED),
					typeof signal.reason === "string" ? signal.reason : "Caller cancelled the request",
				);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			handler.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
		this.pendingRequests.set(id, handler);

		const enrichedParams = method === "initialize" ? params : this.injectMeta(params ?? {});
		const payload = { jsonrpc: "2.0", id, method, params: enrichedParams };
		this.transport!.send(payload, extraHeaders, abortController.signal)
			.then((syncResponse) => {
				if (!syncResponse) return;
				const activeHandler = this.releasePending(id);
				if (!activeHandler) return;
				if (syncResponse.error) {
					const codeStr = syncResponse.error.code !== undefined ? `[${syncResponse.error.code}] ` : "";
					const err = new Error(`${codeStr}${syncResponse.error.message || "Unknown MCP Error"}`);
					(err as any).code = syncResponse.error.code;
					(err as any).data = syncResponse.error.data;
					activeHandler.reject(err);
				} else {
					activeHandler.resolve(syncResponse.result);
				}
			})
			.catch(async (err) => {
				if (!this.pendingRequests.has(id)) return;
				const errMsg = err.message || "";
				if (
					!isRetry &&
					this._protocolMode === "legacy" &&
					(errMsg.includes("[SESSION_EXPIRED]") || this._recoveryPromise)
				) {
					const recovery = this._recoverSession();
					this.releasePending(id);
					try {
						await this.waitForRecovery(recovery, method, signal);
						this._requestWithRetry(method, params, timeoutMs, true, extraHeaders, signal)
							.then(resolve)
							.catch(reject);
					} catch (recoveryErr) {
						if (recoveryErr instanceof McpError && recoveryErr.code === McpErrorCode.REQUEST_CANCELLED) {
							reject(recoveryErr);
						} else {
							reject(
								new McpError(
									`Session recovery failed for "${this.name}": ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`,
									McpErrorCode.SESSION_EXPIRED,
								),
							);
						}
					}
					return;
				}

				const activeHandler = this.releasePending(id);
				activeHandler?.reject(err);
			});
	}

	notification(method: string, params: any, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new McpError(`MCP notification "${method}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED));
				return;
			}
			if (this.isClosed || !this.transport) {
				reject(new McpError(`MCP server "${this.name}" is closed.`, McpErrorCode.CONNECTION_FAILED));
				return;
			}
			const enrichedParams = method === "notifications/initialized" ? params : this.injectMeta(params ?? {});
			const payload = { jsonrpc: "2.0", method, params: enrichedParams };
			this.transport.sendNotification(payload, signal).then(resolve).catch(reject);
		});
	}

	private cacheHintsFromResult(result: Record<string, unknown>): McpCacheHints {
		const explicitTtl = result.ttlMs;
		const explicitScope = result.cacheScope;
		const isLegacy = this._protocolMode === "legacy";
		const hasCredentialContext =
			Object.keys(this._headers ?? {}).length > 0 || Object.keys(this._env ?? {}).length > 0;
		return {
			ttlMs:
				typeof explicitTtl === "number" && Number.isFinite(explicitTtl) && explicitTtl >= 0
					? explicitTtl
					: isLegacy
						? 5 * 60 * 1000
						: 0,
			cacheScope:
				explicitScope === "public" || explicitScope === "private"
					? explicitScope
					: hasCredentialContext
						? "private"
						: "public",
			receivedAt: Date.now(),
		};
	}

	async listToolsWithMetadata(signal?: AbortSignal): Promise<McpCachedList<McpTool>> {
		const result = (await this.request("tools/list", {}, undefined, undefined, signal)) as Record<string, unknown> & {
			tools?: McpTool[];
		};
		let tools = result.tools || [];
		if (this._protocolMode === "modern" && this.transport instanceof StreamableHttpTransport) {
			tools = tools.filter((tool: McpTool) => {
				try {
					validateMcpToolHeaders(tool);
					return true;
				} catch (error) {
					writeLog(
						`[${this.name}] Excluding invalid tool "${tool.name}" from Streamable HTTP tools/list: ${error instanceof Error ? error.message : error}`,
						"WARN",
					);
					return false;
				}
			});
		}
		return { items: tools, ...this.cacheHintsFromResult(result) };
	}

	/** Retrieve the list of tools available on this server. */
	async listTools(signal?: AbortSignal): Promise<McpTool[]> {
		return (await this.listToolsWithMetadata(signal)).items;
	}

	/**
	 * Invoke a tool on the server with MRTR support.
	 * @param name Tool name as reported by {@link listTools}
	 * @param args Tool arguments (key-value object)
	 * @returns Tool execution result (typically `{ content: [...] }`)
	 */
	async callTool(name: string, args: Record<string, any> = {}, tool?: McpTool, signal?: AbortSignal): Promise<any> {
		const requestHeaders =
			this._protocolMode === "modern" && this.transport instanceof StreamableHttpTransport && tool
				? buildMcpParamHeaders(tool, args)
				: undefined;
		return await this._callToolWithMrtr(name, args, undefined, undefined, 0, requestHeaders, signal);
	}

	private async _callToolWithMrtr(
		name: string,
		args: Record<string, any>,
		requestState?: string,
		inputResponses?: Record<string, unknown>[],
		depth = 0,
		requestHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<any> {
		const MAX_MRTR_DEPTH = 5;
		if (depth > MAX_MRTR_DEPTH) {
			throw new McpError(
				`MRTR loop exceeded ${MAX_MRTR_DEPTH} rounds for tool "${name}"`,
				McpErrorCode.INPUT_REQUIRED,
			);
		}

		const params: Record<string, any> = { name, arguments: args };
		if (requestState) {
			params.requestState = requestState;
			params.inputResponses = inputResponses;
		}

		const result = await this.request("tools/call", params, undefined, requestHeaders, signal);

		if (isInputRequired(result)) {
			if (!this.onInputRequired) {
				throw new McpError(
					`Tool "${name}" requires additional input:\n` +
						result.inputRequests.map((r) => `  - ${r.name}: ${r.description || "no description"}`).join("\n") +
						`\n\nRetry with the required input fields added to args.`,
					McpErrorCode.INPUT_REQUIRED,
				);
			}
			const responses = await this.onInputRequired(name, result.inputRequests);
			return this._callToolWithMrtr(name, args, result.requestState, responses, depth + 1, requestHeaders, signal);
		}

		return result;
	}

	async listResourcesWithMetadata(signal?: AbortSignal): Promise<McpCachedList<McpResource>> {
		const result = (await this.request("resources/list", {}, undefined, undefined, signal)) as Record<
			string,
			unknown
		> & {
			resources?: McpResource[];
		};
		return { items: result.resources || [], ...this.cacheHintsFromResult(result) };
	}

	/** List resources exposed by this server. */
	async listResources(signal?: AbortSignal): Promise<McpResource[]> {
		return (await this.listResourcesWithMetadata(signal)).items;
	}

	/**
	 * Read a single resource by URI.
	 * @param uri Resource URI (e.g. `"file:///settings"`)
	 * @returns Resource contents (typically `{ contents: [...] }`)
	 */
	async readResource(uri: string, signal?: AbortSignal): Promise<any> {
		return await this.request("resources/read", { uri }, undefined, undefined, signal);
	}

	/** Recover an expired legacy session once and let every failed request share it. */
	private async _recoverSession(): Promise<void> {
		if (this._recoveryPromise) return this._recoveryPromise;

		let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
		const recoveryWork = (async () => {
			writeLog(`[${this.name}] Connection lost / session expired, reconnecting...`, "WARN");
			if (this.transport) {
				await this.transport.close();
				this.transport = null;
			}
			this.isClosed = false;
			this.transport = this._createTransport();
			this.applyTransportProtocol();
			await this.connect();
			writeLog(`[${this.name}] Session recovery complete`, "INFO");
		})();
		const timeout = new Promise<never>((_, reject) => {
			recoveryTimer = setTimeout(() => {
				reject(
					new McpError(
						`Session recovery for "${this.name}" timed out after ${RECOVERY_ABSOLUTE_TIMEOUT_MS}ms`,
						McpErrorCode.SESSION_EXPIRED,
					),
				);
			}, RECOVERY_ABSOLUTE_TIMEOUT_MS);
		});
		const recovery = Promise.race([recoveryWork, timeout]);
		this._recoveryPromise = recovery;
		try {
			await recovery;
		} finally {
			if (recoveryTimer) clearTimeout(recoveryTimer);
			if (this._recoveryPromise === recovery) this._recoveryPromise = null;
			this._processQueue();
		}
	}

	private cleanupPendingRequests(error: Error) {
		for (const handler of this.pendingRequests.values()) {
			clearTimeout(handler.timer);
			handler.removeAbortListener?.();
			handler.abortController.abort(error.message);
			handler.reject(error);
		}
		this.pendingRequests.clear();
		this.inFlight = 0;
		while (this.requestQueue.length > 0) {
			const req = this.requestQueue.shift()!;
			req.removeAbortListener?.();
			req.reject(error);
		}
	}

	/**
	 * Close client connection.
	 * Pool removes client from map BEFORE calling close(),
	 * so onExit only fires on unexpected process termination.
	 */
	async close() {
		if (this.isClosed) return;
		this.isClosed = true;
		this.cleanupPendingRequests(new McpError("Connection closed.", McpErrorCode.UNKNOWN));
		if (this.transport) {
			await this.transport.close();
			this.transport = null;
		}
	}
}

/**
 * Singleton connection pool with lazy spawning and automatic idle cleanup.
 *
 * **Key behaviors:**
 * - **Lazy spawn:** Servers are started on first use, not at extension load
 * - **Promise dedup:** Concurrent calls to {@link getClient} for the same
 *   server share a single connection attempt
 * - **Exponential backoff:** Retries timed-out connections with 1s→2s→4s delays
 * - **Idle timeout:** Servers unused for `idleTimeout` minutes are auto-closed
 * - **Session recovery:** Streamable HTTP 404 triggers automatic reconnect
 *
 * @example
 * ```ts
 * const pool = McpClientPool.getInstance();
 * const client = await pool.getClient("my-server", serverDef);
 * await client.callTool("search", { query: "..." });
 * await pool.closeAll();
 * ```
 */
import { SimpleMutex } from "./mutex.js";
import { getServerPoolKey } from "./server-identity.js";

interface HealthRecord {
	consecutiveFailures: number;
	lastFailureTime: number;
}

export class McpClientPool {
	private static instance: McpClientPool | null = null;
	private clients = new Map<string, SimpleMcpClient>();
	private activePromises = new Map<string, Promise<SimpleMcpClient>>();
	private activeControllers = new Map<string, AbortController>();
	private activeWaiters = new Map<string, number>();
	private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private serverLocks = new Map<string, SimpleMutex>();
	private healthMap = new Map<string, HealthRecord>();
	private readonly maxFailures = 2;
	private readonly cooldownMs = 5 * 60 * 1000;

	private constructor() {}

	public getMutex(serverName: string, def?: ServerDefinition): SimpleMutex {
		const key = def ? getServerPoolKey(serverName, def) : serverName;
		let lock = this.serverLocks.get(key);
		if (!lock) {
			lock = new SimpleMutex();
			this.serverLocks.set(key, lock);
		}
		return lock;
	}

	/** @returns The singleton pool instance */
	static getInstance(): McpClientPool {
		if (!McpClientPool.instance) McpClientPool.instance = new McpClientPool();
		return McpClientPool.instance;
	}

	private checkCircuitBreaker(key: string, serverName: string): void {
		const record = this.healthMap.get(key);
		if (!record || record.consecutiveFailures < this.maxFailures) return;

		const elapsed = Date.now() - record.lastFailureTime;
		if (elapsed < this.cooldownMs) {
			const remainingSec = Math.ceil((this.cooldownMs - elapsed) / 1000);
			throw new McpError(
				`Circuit breaker open for "${serverName}" due to repeated failures. Fast-failing. Remaining cooldown: ${remainingSec}s. Toggle connection in TUI or run /mcp ${serverName} to reconnect.`,
				McpErrorCode.CONNECTION_FAILED,
			);
		}
		record.consecutiveFailures = 0;
	}

	private recordFailure(key: string, serverName: string): void {
		const record = this.healthMap.get(key) || { consecutiveFailures: 0, lastFailureTime: 0 };
		record.consecutiveFailures++;
		record.lastFailureTime = Date.now();
		this.healthMap.set(key, record);
		writeLog(
			`[Pool] Recorded failure for "${serverName}" (${record.consecutiveFailures}/${this.maxFailures})`,
			"WARN",
		);
	}

	private recordSuccess(key: string): void {
		this.healthMap.delete(key);
	}

	public resetServerHealth(serverName: string, def?: ServerDefinition): void {
		if (def) {
			this.healthMap.delete(getServerPoolKey(serverName, def));
		} else {
			for (const key of this.healthMap.keys()) {
				if (key.startsWith(`${serverName}\0`)) this.healthMap.delete(key);
			}
		}
		writeLog(`[Pool] Reset health and closed circuit breaker for "${serverName}".`, "INFO");
	}

	private waitForConnection(
		key: string,
		serverName: string,
		promise: Promise<SimpleMcpClient>,
		signal?: AbortSignal,
	): Promise<SimpleMcpClient> {
		if (signal?.aborted) {
			return Promise.reject(
				new McpError(`Connection to MCP server "${serverName}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED),
			);
		}
		this.activeWaiters.set(key, (this.activeWaiters.get(key) ?? 0) + 1);
		return new Promise((resolve, reject) => {
			let waiting = true;
			const release = (): boolean => {
				if (!waiting) return false;
				waiting = false;
				signal?.removeEventListener("abort", onAbort);
				const remaining = Math.max(0, (this.activeWaiters.get(key) ?? 1) - 1);
				if (remaining === 0) {
					this.activeWaiters.delete(key);
					if (this.activePromises.get(key) === promise) {
						this.activeControllers.get(key)?.abort(new Error("All connection waiters cancelled"));
					}
				} else {
					this.activeWaiters.set(key, remaining);
				}
				return true;
			};
			const onAbort = () => {
				if (!release()) return;
				reject(
					new McpError(`Connection to MCP server "${serverName}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED),
				);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(client) => {
					if (release()) resolve(client);
				},
				(error) => {
					if (release()) reject(error);
				},
			);
		});
	}

	/** Get or lazily create a client for one exact server definition. */
	async getClient(
		serverName: string,
		def: ServerDefinition,
		debug = false,
		signal?: AbortSignal,
	): Promise<SimpleMcpClient> {
		const key = getServerPoolKey(serverName, def);
		if (signal?.aborted) {
			throw new McpError(`Connection to MCP server "${serverName}" was cancelled.`, McpErrorCode.REQUEST_CANCELLED);
		}
		this.checkCircuitBreaker(key, serverName);

		const existing = this.clients.get(key);
		if (existing) {
			this.resetIdleTimer(key, serverName, def);
			return existing;
		}

		const active = this.activePromises.get(key);
		if (active) return this.waitForConnection(key, serverName, active, signal);

		const connectionController = new AbortController();
		const connectPromise = (async () => {
			let lastError: Error | undefined;
			try {
				for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
					let client: SimpleMcpClient | undefined;
					try {
						if (attempt > 0) {
							const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
							writeLog(
								`[Pool] Retrying "${serverName}" (attempt ${attempt}) after: ${lastError?.message}. Waiting ${delay}ms...`,
								"WARN",
							);
							await new Promise((resolve) => setTimeout(resolve, delay));
						}
						writeLog(`[Pool] Lazy-spawning server "${serverName}"...`, "INFO");

						client = new SimpleMcpClient(
							serverName,
							def.command,
							def.args,
							def.env,
							def.url,
							def.headers,
							def.debug || debug,
							def.type,
							def.initTimeout,
							def.cwd,
							def.maxConcurrentRequests,
							def.protocolMode,
						);

						if (def.auth === "bearer") {
							const token = resolveBearerToken(def);
							if (token) client.setBearerToken(token);
						}

						client.onExit = () => {
							if (this.clients.get(key) !== client) return;
							this.clients.delete(key);
							this.clearIdleTimer(key);
							this.recordFailure(key, serverName);
						};

						await client.connect(connectionController.signal);
						this.recordSuccess(key);
						this.clients.set(key, client);
						this.resetIdleTimer(key, serverName, def);
						return client;
					} catch (err: any) {
						if (client) {
							try {
								await client.close();
							} catch (closeErr) {
								writeLog(
									`[Pool] Failed to close unsuccessful connection for "${serverName}": ${closeErr}`,
									"WARN",
								);
							}
						}
						lastError = err;
						if (
							!err.message?.includes("timed out") &&
							!(err instanceof McpError && err.code === McpErrorCode.CONNECTION_TIMEOUT)
						) {
							break;
						}
					}
				}
				if (connectionController.signal.aborted && lastError) throw lastError;
				this.recordFailure(key, serverName);
				const originalMsg = lastError ? lastError.message : "Unknown error";
				writeLog(`[Pool] Connection to "${serverName}" failed. Original error: ${originalMsg}`, "ERROR");
				throw new McpError(
					`MCP server "${serverName}" connection failed. Check log for details.`,
					McpErrorCode.CONNECTION_FAILED,
				);
			} finally {
				this.activePromises.delete(key);
				this.activeControllers.delete(key);
			}
		})();

		this.activePromises.set(key, connectPromise);
		this.activeControllers.set(key, connectionController);
		return this.waitForConnection(key, serverName, connectPromise, signal);
	}

	async closeClient(serverName: string, def?: ServerDefinition): Promise<void> {
		const keys = def
			? [getServerPoolKey(serverName, def)]
			: Array.from(new Set([...this.clients.keys(), ...this.activePromises.keys()])).filter((key) =>
					key.startsWith(`${serverName}\0`),
				);
		await Promise.all(
			keys.map(async (key) => {
				this.clearIdleTimer(key);
				this.activeControllers.get(key)?.abort(new Error(`Connection to "${serverName}" was closed`));
				const active = this.activePromises.get(key);
				if (active) await Promise.allSettled([active]);
				const client = this.clients.get(key);
				if (!client) return;
				this.clients.delete(key);
				writeLog(`[Pool] Closing server "${serverName}"...`, "INFO");
				await client.close();
			}),
		);
	}

	async closeAll(): Promise<void> {
		for (const controller of this.activeControllers.values()) {
			controller.abort(new Error("MCP connection pool is closing"));
		}
		await Promise.allSettled(Array.from(this.activePromises.values()));
		this.activePromises.clear();
		this.activeControllers.clear();
		this.activeWaiters.clear();
		for (const key of Array.from(this.idleTimers.keys())) this.clearIdleTimer(key);
		const clients = Array.from(this.clients.entries());
		this.clients.clear();
		this.healthMap.clear();
		this.serverLocks.clear();
		await Promise.all(clients.map(([, client]) => client.close()));
	}

	getActiveClients(): string[] {
		return Array.from(new Set(Array.from(this.clients.values(), (client) => client.name)));
	}

	isClientActive(serverName: string, def: ServerDefinition): boolean {
		return this.clients.has(getServerPoolKey(serverName, def));
	}

	touch(serverName: string, def?: ServerDefinition) {
		if (!def) return;
		const key = getServerPoolKey(serverName, def);
		if (this.clients.has(key)) this.resetIdleTimer(key, serverName, def);
	}

	private resetIdleTimer(key: string, serverName: string, def: ServerDefinition) {
		this.clearIdleTimer(key);
		const idleMinutes = def.idleTimeout !== undefined ? def.idleTimeout : 10;
		if (idleMinutes <= 0) return;

		const timer = setTimeout(
			() => {
				this.closeClient(serverName, def).catch((err) => {
					writeLog(`[Pool] Failed to auto-close "${serverName}": ${err}`, "ERROR");
				});
			},
			idleMinutes * 60 * 1000,
		);
		this.idleTimers.set(key, timer);
	}

	private clearIdleTimer(key: string) {
		const timer = this.idleTimers.get(key);
		if (timer) clearTimeout(timer);
		this.idleTimers.delete(key);
	}
}
