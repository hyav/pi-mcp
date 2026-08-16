// stdio-transport.ts
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { serializeBoundedMcpPayload } from "./bounded-response.js";
import { redactLogMessage, writeLog } from "./logger.js";

const SIGKILL_GRACE_PERIOD_MS = 3_000;
export const MAX_STDIO_LINE_BYTES = 10 * 1024 * 1024;

const INHERITED_ENV_KEYS = new Set(
	[
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"APPDATA",
		"LOCALAPPDATA",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"LANG",
		"LANGUAGE",
		"TERM",
		"COLORTERM",
		"TZ",
		"CI",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"ALL_PROXY",
		"NODE_EXTRA_CA_CERTS",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"REQUESTS_CA_BUNDLE",
		"CURL_CA_BUNDLE",
	].map((key) => key.toUpperCase()),
);

export function buildSubprocessEnv(explicit?: Record<string, string>): NodeJS.ProcessEnv {
	const inherited: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const upper = key.toUpperCase();
		if (INHERITED_ENV_KEYS.has(upper) || upper.startsWith("LC_")) inherited[key] = value;
	}
	return { ...inherited, ...explicit };
}

export class BoundedNdjsonParser {
	private buffer = Buffer.alloc(0);

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly onOverflow: () => void,
		private readonly maxBytes = MAX_STDIO_LINE_BYTES,
	) {}

	push(chunk: Buffer | Uint8Array | string) {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.buffer = Buffer.concat([this.buffer, incoming]);
		while (true) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline === -1) {
				if (this.buffer.byteLength > this.maxBytes) {
					this.buffer = Buffer.alloc(0);
					this.onOverflow();
				}
				return;
			}
			if (newline > this.maxBytes) {
				this.buffer = this.buffer.subarray(newline + 1);
				this.onOverflow();
				return;
			}
			const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			this.buffer = this.buffer.subarray(newline + 1);
			this.onLine(line);
		}
	}
}

/**
 * Callbacks that a transport fires to notify the upper {@link SimpleMcpClient} layer.
 */
export interface TransportHooks {
	/** A JSON-RPC response (or notification) arrived from the server */
	onMessage: (response: any) => void;
	/** The underlying connection terminated unexpectedly */
	onExit: (reason: string) => void;
}

/** Resolve an npx package only from the configured project's node_modules. */
function resolveNpxBinary(packageSpec: string, cwd?: string): { binPath: string; isJs: boolean } | null {
	try {
		// 1. First attempt to resolve from project-local node_modules if cwd is provided
		if (cwd) {
			const localPackagePath = join(cwd, "node_modules", packageSpec);
			if (existsSync(localPackagePath)) {
				const pkgJsonPath = join(localPackagePath, "package.json");
				if (existsSync(pkgJsonPath)) {
					const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
					const binField = pkg.bin;
					if (binField) {
						let binRel: string | undefined;
						if (typeof binField === "string") {
							binRel = binField;
						} else if (typeof binField === "object") {
							const baseName = packageSpec.includes("/") ? packageSpec.split("/")[1] : packageSpec;
							binRel = binField[baseName] || Object.values(binField)[0];
						}

						if (binRel) {
							const fullBinPath = resolve(localPackagePath, binRel);
							if (existsSync(fullBinPath)) {
								const isJs =
									fullBinPath.endsWith(".js") || fullBinPath.endsWith(".cjs") || fullBinPath.endsWith(".mjs");
								writeLog(
									`[NpxResolver] Found locally installed package in node_modules: ${packageSpec} -> ${fullBinPath}`,
									"INFO",
								);
								return { binPath: fullBinPath, isJs };
							}
						}
					}
				}
			}
		}

		// Do not execute an arbitrary stale package from the global npx cache. If the
		// project-local dependency is absent, preserve npx's own version resolution.
	} catch (err) {
		writeLog(`Error in resolveNpxBinary: ${err}`, "DEBUG");
	}
	return null;
}

/**
 * MCP transport over a local child process (stdin/stdout JSON-RPC).
 *
 * Spawns the configured command, parses newline-delimited JSON on stdout,
 * writes JSON-RPC payloads to stdin, and handles process lifecycle events.
 *
 * Skips the npm parent process only when the exact package is installed in
 * the configured project's node_modules; otherwise npx performs normal resolution.
 */
export class StdioTransport {
	private child: ChildProcess | null = null;
	private hooks: TransportHooks | null = null;
	private stderrBuffer: string[] = [];
	private isClosed = false;
	private serverName: string;
	private command: string;
	private args: string[];
	private env?: Record<string, string>;
	private cwd?: string;
	private debug: boolean;

	constructor(
		serverName: string,
		command: string,
		args: string[],
		env?: Record<string, string>,
		cwd?: string,
		debug = false,
	) {
		this.serverName = serverName;
		this.command = command;
		this.args = args;
		this.env = env;
		this.cwd = cwd;
		this.debug = debug;
	}

	async connect(hooks: TransportHooks, signal?: AbortSignal): Promise<any> {
		signal?.throwIfAborted();
		this.hooks = hooks;
		this.isClosed = false;
		this.stderrBuffer = [];

		const finalEnv = buildSubprocessEnv(this.env);

		let spawnCmd = this.command;
		let spawnArgs = [...this.args];

		// Resolve only an exact project-local dependency; never pick an arbitrary global cache entry.
		if (spawnCmd === "npx") {
			const resolved = this.resolveNpxToDirect(spawnArgs);
			if (resolved) {
				spawnCmd = resolved.cmd;
				spawnArgs = resolved.args;
			}
		}

		this.child = spawn(spawnCmd, spawnArgs, {
			env: finalEnv,
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child.stdin!.on("error", (err) => {
			writeLog(`[${this.serverName}] stdin stream error: ${err.message}`, "WARN");
		});

		const parser = new BoundedNdjsonParser(
			(line) => {
				if (this.isClosed) return;
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
				try {
					this.hooks?.onMessage(JSON.parse(trimmed));
				} catch (err) {
					writeLog(`[${this.serverName}] Failed to parse stdout JSON-RPC line: ${err}`, "ERROR");
				}
			},
			() => {
				const reason = "PAYLOAD_TOO_LARGE: STDIO JSON-RPC line exceeds the 10MB safety limit.";
				writeLog(`[${this.serverName}] ${reason}`, "ERROR");
				if (!this.isClosed) {
					this.isClosed = true;
					this.hooks?.onExit(reason);
					this.child?.kill("SIGTERM");
				}
			},
		);
		this.child.stdout!.on("data", (chunk) => parser.push(chunk));

		// Stderr logging
		const stderrRl = readline.createInterface({
			input: this.child.stderr!,
			terminal: false,
		});
		stderrRl.on("line", (line) => {
			// Keep crash diagnostics bounded and prevent them from bypassing the central log redactor.
			const boundedLine = line.length > 500 ? `${line.substring(0, 497)}...` : line;
			const safeLine = redactLogMessage(boundedLine);
			writeLog(`[${this.serverName} stderr] ${safeLine}`, "INFO");
			if (this.debug) {
				writeLog(`[${this.serverName} debug] ${safeLine}`, "INFO");
			}
			this.stderrBuffer.push(safeLine);
			if (this.stderrBuffer.length > 20) {
				this.stderrBuffer.shift();
			}
		});

		// Process lifecycle
		this.child.on("exit", (code, signal) => {
			let crashReason = "";
			if (code !== 0 && code !== null && this.stderrBuffer.length > 0) {
				crashReason = `\nLast server outputs:\n${this.stderrBuffer.map((l) => `  > ${l}`).join("\n")}`;
			}
			writeLog(`[${this.serverName}] Process exited. Code: ${code}, Signal: ${signal}`, "WARN");
			if (!this.isClosed) {
				this.isClosed = true;
				this.hooks?.onExit(
					`MCP server process exited unexpectedly (code ${code}, signal ${signal}).${crashReason}`,
				);
			}
		});

		this.child.on("error", (err) => {
			writeLog(`[${this.serverName}] Process error: ${err}`, "ERROR");
			if (!this.isClosed) {
				this.isClosed = true;
				this.hooks?.onExit(err.message);
			}
		});

		// Return a placeholder — the actual init is handled by SimpleMcpClient.request()
		return null;
	}

	async send(
		payload: Record<string, unknown>,
		_extraHeaders?: Record<string, string>,
		_signal?: AbortSignal,
	): Promise<void> {
		if (this.isClosed || !this.child?.stdin) {
			throw new Error(`STDIO server "${this.serverName}" is not connected.`);
		}
		const payloadStr = `${serializeBoundedMcpPayload(payload)}\n`;
		return new Promise((resolve, reject) => {
			this.child!.stdin!.write(payloadStr, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	async sendNotification(payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		return this.send(payload, undefined, signal);
	}

	async close(): Promise<void> {
		if (this.isClosed) return;
		this.isClosed = true;

		if (this.child) {
			const child = this.child;
			this.child = null;

			try {
				child.kill("SIGTERM");
			} catch {
				return;
			}

			await new Promise<void>((resolve) => {
				const killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					resolve();
				}, SIGKILL_GRACE_PERIOD_MS);

				child.once("exit", () => {
					clearTimeout(killTimer);
					resolve();
				});
			});
		}
	}

	private resolveNpxToDirect(args: string[]): { cmd: string; args: string[] } | null {
		let packageSpec: string | undefined;
		let argStartIndex = 0;
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-y" || args[i] === "--yes") continue;
			if (args[i].startsWith("-")) return null;
			packageSpec = args[i];
			argStartIndex = i + 1;
			break;
		}

		if (!packageSpec) return null;

		const resolved = resolveNpxBinary(packageSpec, this.cwd);
		if (!resolved) {
			writeLog(
				`[${this.serverName}] npx-resolver bypassed: ${packageSpec} not found in project node_modules, falling back to npx`,
				"INFO",
			);
			return null;
		}

		writeLog(`[${this.serverName}] npx-resolver matched: ${packageSpec} -> ${resolved.binPath}`, "INFO");
		const extraArgs = args.slice(argStartIndex);
		if (resolved.isJs) {
			const execName = process.execPath ? process.execPath.split(/[/\\]/).pop() || "" : "";
			const isNode = /^(node|bun|deno)(?:\.exe)?$/i.test(execName);
			const nodeCmd = isNode ? process.execPath : "node";
			return { cmd: nodeCmd, args: [resolved.binPath, ...extraArgs] };
		}
		return { cmd: resolved.binPath, args: extraArgs };
	}
}
