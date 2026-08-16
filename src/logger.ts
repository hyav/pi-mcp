// logger.ts
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getLogFilePath(): string {
	return join(getAgentDir(), "mcp.log");
}
const sensitiveValues = new Set<string>();
const REDACTED = "[REDACTED]";

/** Replace the credential set atomically; values are retained in memory only. */
export function setSensitiveLogValues(values: Iterable<string>): void {
	sensitiveValues.clear();
	registerSensitiveLogValues(values);
}

/** Retain additional values so credentials for still-closing clients remain redacted after a config reload. */
export function registerSensitiveLogValues(values: Iterable<string>): void {
	for (const value of values) {
		if (value.length >= 4) sensitiveValues.add(value);
	}
}

export function redactLogMessage(message: string): string {
	let redacted = message;
	for (const value of sensitiveValues) {
		redacted = redacted.split(value).join(REDACTED);
	}
	redacted = redacted
		.replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
		.replace(
			/(\b(?:authorization|proxy-authorization|api[-_]?key|token|secret|password|cookie)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			`$1${REDACTED}`,
		)
		.replace(/(https?:\/\/)[^/@\s]+@/gi, `$1${REDACTED}@`)
		.replace(/([?&][^=&#\s]+=)[^&#\s]*/g, `$1${REDACTED}`);
	return redacted;
}

export function writeLog(message: string, level: "INFO" | "WARN" | "ERROR" | "DEBUG" = "INFO"): void {
	try {
		const logFilePath = getLogFilePath();
		const dir = dirname(logFilePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] [${level}] ${redactLogMessage(message)}\n`;
		appendFileSync(logFilePath, line, { encoding: "utf8", mode: 0o600 });
		chmodSync(logFilePath, 0o600);
	} catch (err) {
		// Write to stderr only — never corrupt stdout which carries JSON-RPC
		try {
			process.stderr.write(`[MCP Kit Logger] Write failed: ${err}\n`);
		} catch {
			// Absolute last resort: truly silent
		}
	}
}
