// config.ts
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getExtensionDataDir, registerSensitiveLogValues, writeLog } from "./logger.js";
import type { ConfigSource, McpConfig, ServerDefinition } from "./types.js";

export function getGlobalConfigPaths(): string[] {
	return [join(getAgentDir(), "mcp.json"), join(homedir(), ".config", "mcp", "mcp.json")];
}

export const LOCAL_CONFIG_NAMES = [`${CONFIG_DIR_NAME}/mcp.json`, ".mcp.json"];

export function getThirdPartyIdePaths(
	home = homedir(),
	environment: NodeJS.ProcessEnv = process.env,
	targetPlatform = process.platform,
): { name: string; path: string }[] {
	const pathApi = targetPlatform === "win32" ? win32 : posix;
	const claudeDesktopPath =
		targetPlatform === "darwin"
			? pathApi.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
			: targetPlatform === "win32"
				? pathApi.join(
						environment.APPDATA || pathApi.join(home, "AppData", "Roaming"),
						"Claude",
						"claude_desktop_config.json",
					)
				: pathApi.join(
						environment.XDG_CONFIG_HOME || pathApi.join(home, ".config"),
						"Claude",
						"claude_desktop_config.json",
					);
	return [
		{ name: "Cursor", path: pathApi.join(home, ".cursor", "mcp.json") },
		{ name: "Claude Code", path: pathApi.join(home, ".claude", "mcp.json") },
		{ name: "Claude Desktop", path: claudeDesktopPath },
	];
}

const THIRD_PARTY_IDE_PATHS = getThirdPartyIdePaths();
export function getTrustFilePath(): string {
	return join(getExtensionDataDir(), "mcp-trusted-workspaces.json");
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function assertStringRecord(value: unknown, field: string): void {
	if (value === undefined) return;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object of string values`);
	}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`${field}.${key} must be a string`);
	}
}

function validateServerDefinition(serverName: string, def: ServerDefinition, source: ConfigSource): void {
	if (!def || typeof def !== "object" || Array.isArray(def)) {
		throw new Error(`[Config] ${source} server "${serverName}" must be an object.`);
	}
	const hasCommand = typeof def.command === "string" && def.command.length > 0;
	const hasUrl = typeof def.url === "string" && def.url.length > 0;
	if (hasCommand === hasUrl) {
		throw new Error(`[Config] ${source} server "${serverName}" must define exactly one of command or url.`);
	}
	if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((arg) => typeof arg !== "string"))) {
		throw new Error(`[Config] ${source} server "${serverName}" args must be an array of strings.`);
	}
	assertStringRecord(def.env, `[Config] ${source} server "${serverName}" env`);
	assertStringRecord(def.headers, `[Config] ${source} server "${serverName}" headers`);
	if (hasUrl) {
		const protocol = new URL(def.url!).protocol;
		if (protocol !== "http:" && protocol !== "https:") {
			throw new Error(`[Config] ${source} server "${serverName}" URL must use http or https.`);
		}
	}
	if (def.auth !== undefined && def.auth !== "bearer") {
		throw new Error(`[Config] ${source} server "${serverName}" uses unsupported auth mode "${def.auth}".`);
	}
	for (const [field, value] of [
		["cwd", def.cwd],
		["bearerToken", def.bearerToken],
		["bearerTokenEnv", def.bearerTokenEnv],
	] as const) {
		if (value !== undefined && typeof value !== "string") {
			throw new Error(`[Config] ${source} server "${serverName}" ${field} must be a string.`);
		}
	}
	if (def.type !== undefined && def.type !== "sse" && def.type !== "streamable-http") {
		throw new Error(`[Config] ${source} server "${serverName}" uses unsupported transport type "${def.type}".`);
	}
	if (
		def.protocolMode !== undefined &&
		def.protocolMode !== "auto" &&
		def.protocolMode !== "legacy" &&
		def.protocolMode !== "modern"
	) {
		throw new Error(`[Config] ${source} server "${serverName}" uses unsupported protocolMode "${def.protocolMode}".`);
	}
	if (def.debug !== undefined && typeof def.debug !== "boolean") {
		throw new Error(`[Config] ${source} server "${serverName}" debug must be a boolean.`);
	}
	if (def.idleTimeout !== undefined && (!Number.isFinite(def.idleTimeout) || def.idleTimeout < 0)) {
		throw new Error(`[Config] ${source} server "${serverName}" idleTimeout must be a non-negative number.`);
	}
	if (def.initTimeout !== undefined && (!Number.isFinite(def.initTimeout) || def.initTimeout <= 0)) {
		throw new Error(`[Config] ${source} server "${serverName}" initTimeout must be a positive number.`);
	}
	if (
		def.maxConcurrentRequests !== undefined &&
		(!Number.isSafeInteger(def.maxConcurrentRequests) || def.maxConcurrentRequests < 1)
	) {
		throw new Error(`[Config] ${source} server "${serverName}" maxConcurrentRequests must be a positive integer.`);
	}
}

function tagAndValidateServers(
	servers: Record<string, ServerDefinition>,
	source: ConfigSource,
): Record<string, ServerDefinition> {
	const result: Record<string, ServerDefinition> = {};
	if (!servers || typeof servers !== "object") return result;

	for (const [name, def] of Object.entries(servers)) {
		try {
			validateServerDefinition(name, def, source);
			result[name] = { ...def, _source: source };
		} catch (err: any) {
			writeLog(err.message, "ERROR");
		}
	}
	return result;
}

// --- Trust management ---

export function getTrustedWorkspaces(): string[] {
	const trustFilePath = getTrustFilePath();
	if (!existsSync(trustFilePath)) return [];
	try {
		const raw = readFileSync(trustFilePath, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((p: string) => safeRealpath(p));
	} catch {
		return [];
	}
}

export function addTrustedWorkspace(path: string) {
	const normalized = safeRealpath(path);
	const list = getTrustedWorkspaces();
	if (!list.includes(normalized)) {
		list.push(normalized);
		const trustFilePath = getTrustFilePath();
		const tmpPath = `${trustFilePath}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			mkdirSync(dirname(trustFilePath), { recursive: true, mode: 0o700 });
			writeFileSync(tmpPath, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
			renameSync(tmpPath, trustFilePath);
		} catch (err) {
			writeLog(`Failed to write trusted workspaces file atomically: ${err}`, "ERROR");
			try {
				if (existsSync(tmpPath)) {
					unlinkSync(tmpPath);
				}
			} catch {}
		}
	}
}

export function isTrustedWorkspace(cwd: string): boolean {
	const normalizedCwd = safeRealpath(cwd);
	return getTrustedWorkspaces().includes(normalizedCwd);
}

// --- Config loading with Auto-Discovery ---

export function loadMcpConfig(customPath?: string, cwd = process.cwd(), projectTrusted = false): McpConfig {
	const mergedConfig: McpConfig = { mcpServers: {} };
	const normalizedCwd = safeRealpath(cwd);

	// 1. Load global configs (fully trusted)
	for (const globalPath of getGlobalConfigPaths()) {
		if (existsSync(globalPath)) {
			try {
				const raw = readFileSync(globalPath, "utf8");
				const parsed = JSON.parse(raw);
				if (parsed.mcpServers) {
					const tagged = tagAndValidateServers(parsed.mcpServers, "global");
					mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
				}
				if (parsed.settings) {
					mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
				}
				break; // Stop at first found global config
			} catch (err) {
				writeLog(`Failed to parse global config at ${globalPath}: ${err}`, "ERROR");
			}
		}
	}

	// 2. Third-party configurations are executable and therefore disabled until the
	// trusted global config explicitly opts in.
	if (mergedConfig.settings?.enableThirdPartyConfig === true) {
		for (const { name, path } of THIRD_PARTY_IDE_PATHS) {
			if (!existsSync(path)) continue;
			try {
				const raw = readFileSync(path, "utf8");
				const parsed = JSON.parse(raw);
				if (parsed.mcpServers) {
					const tagged = tagAndValidateServers(parsed.mcpServers, "third-party");
					for (const [serverName, def] of Object.entries(tagged)) {
						if (!mergedConfig.mcpServers[serverName]) {
							mergedConfig.mcpServers[serverName] = def;
							writeLog(`Discovered and imported trusted ${name} server config: "${serverName}"`, "INFO");
						}
					}
				}
			} catch (err) {
				writeLog(`Skipped auto-discover for ${name} configuration: ${err}`, "DEBUG");
			}
		}
	}

	// 3. Load local project config ONLY IF enabled in global settings AND CWD is trusted
	const enableLocal = mergedConfig.settings?.enableLocalConfig === true;
	if (enableLocal) {
		const trustedList = getTrustedWorkspaces();
		if (projectTrusted || trustedList.includes(normalizedCwd)) {
			for (const localName of LOCAL_CONFIG_NAMES) {
				const localPath = resolve(normalizedCwd, localName);
				if (existsSync(localPath)) {
					try {
						const raw = readFileSync(localPath, "utf8");
						const parsed = JSON.parse(raw);
						if (parsed.mcpServers) {
							const tagged = tagAndValidateServers(parsed.mcpServers, "local");
							mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
						}
						if (parsed.settings) {
							mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
						}
						break;
					} catch (err) {
						writeLog(`Failed to parse local config at ${localPath}: ${err}`, "ERROR");
					}
				}
			}
		}
	}

	// 4. Load custom config if specified (highest precedence, validated)
	if (customPath && existsSync(customPath)) {
		try {
			const raw = readFileSync(customPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.mcpServers) {
				const tagged = tagAndValidateServers(parsed.mcpServers, "custom");
				mergedConfig.mcpServers = { ...mergedConfig.mcpServers, ...tagged };
			}
			if (parsed.settings) {
				mergedConfig.settings = { ...mergedConfig.settings, ...parsed.settings };
			}
		} catch (err) {
			writeLog(`Failed to parse custom config at ${customPath}: ${err}`, "ERROR");
		}
	}

	// 5. Expand variables only after every executable source has crossed an explicit trust boundary.
	mergedConfig.mcpServers = expandEnvVars(mergedConfig.mcpServers);
	const sensitiveValues: string[] = [];
	for (const definition of Object.values(mergedConfig.mcpServers)) {
		sensitiveValues.push(...Object.values(definition.env ?? {}), ...Object.values(definition.headers ?? {}));
		if (definition.bearerToken) sensitiveValues.push(definition.bearerToken);
		if (definition.bearerTokenEnv) {
			const token = process.env[definition.bearerTokenEnv];
			if (token) sensitiveValues.push(token);
		}
		for (let index = 0; index < (definition.args?.length ?? 0); index++) {
			const argument = definition.args![index];
			const inlineSecret = argument.match(/^(?:--?)?[^=]*(?:token|secret|password|api[-_]?key)[^=]*=(.+)$/i);
			if (inlineSecret?.[1]) sensitiveValues.push(inlineSecret[1]);
			if (/(?:token|secret|password|api[-_]?key)/i.test(argument) && definition.args![index + 1]) {
				sensitiveValues.push(definition.args![index + 1]);
			}
		}
	}
	registerSensitiveLogValues(sensitiveValues);
	const defaultIdleTimeout = mergedConfig.settings?.idleTimeout;
	if (defaultIdleTimeout !== undefined && (!Number.isFinite(defaultIdleTimeout) || defaultIdleTimeout < 0)) {
		writeLog("Ignoring invalid global idleTimeout; expected a non-negative number of minutes.", "WARN");
	} else if (defaultIdleTimeout !== undefined) {
		for (const definition of Object.values(mergedConfig.mcpServers)) {
			if (definition.idleTimeout === undefined) definition.idleTimeout = defaultIdleTimeout;
		}
	}

	return mergedConfig;
}

/**
 * Recursively expand ${VAR_NAME} placeholders in strings with process.env values.
 * Unresolved variables are preserved as-is.
 */
function expandEnvVars<T>(obj: T): T {
	if (typeof obj === "string") {
		return obj
			.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
				return process.env[varName] ?? _match;
			})
			.replace(/\$env:(\w+)/g, (_match, varName: string) => {
				return process.env[varName] ?? _match;
			}) as unknown as T;
	}
	if (Array.isArray(obj)) {
		return obj.map(expandEnvVars) as unknown as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			result[key] = expandEnvVars(value);
		}
		return result as unknown as T;
	}
	return obj;
}
