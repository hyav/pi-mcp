// sse-transport.ts
import { MAX_MCP_RESPONSE_BYTES, readBoundedResponseText, serializeBoundedMcpPayload } from "./bounded-response.js";
import { writeLog } from "./logger.js";
import type { TransportHooks } from "./stdio-transport.js";

/** Extract JSON-RPC response from an SSE text body */
function parseSseText(sseText: string): any {
	const events = sseText.replace(/\r\n|\r/g, "\n").split("\n\n");
	for (const event of events) {
		const lines = event.split("\n");
		const dataLines: string[] = [];
		for (const line of lines) {
			// Skip event: lines to avoid picking up non-message events
			if (line.startsWith("event:") && !line.includes("message")) {
				dataLines.length = 0;
				break;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.substring(5).trimStart());
			}
		}
		if (dataLines.length > 0) {
			try {
				return JSON.parse(dataLines.join("\n"));
			} catch {
				// try next event
			}
		}
	}
	return null;
}

/**
 * MCP transport over Server-Sent Events (legacy MCP HTTP).
 *
 * Opens a GET SSE stream, discovers the POST endpoint via the `endpoint` event,
 * then sends JSON-RPC requests via POST to that endpoint. Responses may arrive
 * synchronously on the POST response or asynchronously on the SSE stream.
 *
 * This is the older MCP HTTP transport; prefer {@link StreamableHttpTransport}
 * for new servers.
 */
/**
 * @deprecated SSE transport is deprecated per MCP 2026-07-28 (SEP-2596).
 * Migrate to Streamable HTTP. Will be removed after 2027-07-28.
 */
export class SseTransport {
	private postUrl: string | null = null;
	private abortController: AbortController | null = null;
	private hooks: TransportHooks | null = null;
	private isClosed = false;

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
		this.postUrl = null;
		this.abortController = new AbortController();

		writeLog(`[${this.serverName}] Establishing SSE connection to: ${this.url}`, "INFO");

		const onAbort = () => this.abortController?.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutId = setTimeout(() => {
			this.abortController?.abort(new Error("SSE connection timed out"));
		}, this.connectTimeoutMs);

		let response: Response;
		try {
			response = await fetch(this.url, {
				headers: {
					Accept: "text/event-stream",
					...this.headers,
				},
				signal: this.abortController.signal,
			});
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}

		if (!response.ok) {
			throw new Error(`SSE HTTP error: ${response.status} ${response.statusText}`);
		}

		if (!response.body) throw new Error(`SSE endpoint ${this.url} returned no response body`);
		this.readSseStream(response.body.getReader());

		const deadline = Date.now() + this.connectTimeoutMs;
		while (!this.postUrl && Date.now() < deadline) {
			signal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		if (!this.postUrl) {
			throw new Error(`SSE Handshake timeout: No 'endpoint' event received from ${this.url}`);
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
						this.hooks?.onExit("SSE stream ended");
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
						this.parseSseEvent(chunk);
					}
				}
			}
		} catch (err: any) {
			if (!this.isClosed) {
				writeLog(`[${this.serverName}] SSE stream closed with error: ${err.message}`, "WARN");
				this.isClosed = true;
				this.hooks?.onExit(`SSE stream error: ${err.message}`);
			}
		}
	}

	private parseSseEvent(chunk: string) {
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

		const dataContent = dataLines.join("\n");

		if (eventName === "endpoint") {
			try {
				this.postUrl = new URL(dataContent, this.url).toString();
				writeLog(`[${this.serverName}] Discovered SSE POST endpoint`, "INFO");
			} catch {
				this.postUrl = dataContent;
			}
		} else if (eventName === "message" && dataContent) {
			try {
				const response = JSON.parse(dataContent);
				this.hooks?.onMessage(response);
			} catch (err) {
				writeLog(`[${this.serverName}] Failed to parse JSON message from SSE: ${err}`, "ERROR");
			}
		}
	}

	async send(
		payload: Record<string, unknown>,
		_extraHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<any | null> {
		if (!this.postUrl) throw new Error("No SSE POST endpoint available.");

		const res = await fetch(this.postUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers,
			},
			body: serializeBoundedMcpPayload(payload),
			signal,
		});

		if (res.status === 200) {
			const contentType = res.headers.get("content-type") ?? "";
			const text = await readBoundedResponseText(res);
			if (!text) return null;

			// JSON response
			if (contentType.includes("application/json")) {
				try {
					return JSON.parse(text);
				} catch {
					writeLog(`[${this.serverName}] Failed to parse JSON from POST response`, "ERROR");
					return null;
				}
			}

			// SSE body response (server sent response inline instead of via stream)
			if (contentType.includes("text/event-stream")) {
				return parseSseText(text);
			}

			// Unknown content-type: try JSON first, then SSE
			try {
				return JSON.parse(text);
			} catch {
				return parseSseText(text);
			}
		}

		if (res.status === 202) {
			return null; // Accepted, response via SSE stream
		}

		if (res.status === 401 || res.status === 403) {
			throw new Error(`[UNAUTHORIZED] ${res.status} ${res.statusText}`);
		}

		throw new Error(`SSE POST error: ${res.status} ${res.statusText}`);
	}

	async sendNotification(payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		await this.send(payload, undefined, signal);
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
