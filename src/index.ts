// index.ts

import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getFreshServerCacheEntry, loadMetadataCache } from "./cache.js";
import { McpClientPool } from "./client.js";
import { loadMcpConfig } from "./config.js";
import { classifyExecutionMode } from "./dispatch-classifier.js";
import { writeLog } from "./logger.js";
import { refreshServerMetadata } from "./metadata.js";
import { cleanupSpilledTempDirs, handleMcpProxy } from "./proxy.js";
import { getServerCacheFingerprint, getServerConnectionFingerprint } from "./server-identity.js";
import type { McpConfig, MetadataCache, ServerCacheEntry } from "./types.js";

function getActiveCacheEntry(
	cache: MetadataCache,
	config: McpConfig,
	serverName: string,
): ServerCacheEntry | undefined {
	const definition = config.mcpServers[serverName];
	return definition
		? getFreshServerCacheEntry(
				cache,
				serverName,
				getServerCacheFingerprint(definition),
				getServerConnectionFingerprint(definition),
			)
		: undefined;
}

function cleanDescription(desc?: string): string {
	if (!desc) return "No description available";
	let firstLine = desc.split("\n")[0].trim();
	const bloatTerms = [
		"error responses",
		"http status",
		"response codes",
		"unauthorized",
		"internal server error",
		"errors:",
	];
	for (const term of bloatTerms) {
		const idx = firstLine.toLowerCase().indexOf(term);
		if (idx !== -1) {
			firstLine = firstLine.substring(0, idx).trim();
		}
	}
	firstLine = firstLine.replace(/[:\-,\s]+$/, "").trim();
	if (firstLine.length > 80) {
		return `${firstLine.substring(0, 77)}...`;
	}
	return firstLine || "No description available";
}

function getSimilarity(s1: string, s2: string): number {
	const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const c1 = clean(s1);
	const c2 = clean(s2);
	if (c1 === c2) return 1.0;
	if (c1.includes(c2) || c2.includes(c1)) return 0.8;

	const len = Math.max(c1.length, c2.length);
	if (len === 0) return 1.0;

	let dist = 0;
	for (let i = 0; i < Math.min(c1.length, c2.length); i++) {
		if (c1[i] !== c2[i]) dist++;
	}
	dist += Math.abs(c1.length - c2.length);
	return (len - dist) / len;
}

export interface ToolRouteCandidate {
	serverName: string;
	toolName: string;
}

export function resolveToolTarget(
	availableTools: ToolRouteCandidate[],
	requestedTool: string,
	requestedServer?: string,
): ToolRouteCandidate | null {
	if (requestedServer) {
		return (
			availableTools.find(
				(candidate) => candidate.serverName === requestedServer && candidate.toolName === requestedTool,
			) ?? null
		);
	}
	const qualified = availableTools.filter(
		(candidate) =>
			`${candidate.serverName}-${candidate.toolName}` === requestedTool ||
			`${candidate.serverName}_${candidate.toolName}` === requestedTool,
	);
	if (qualified.length > 1) {
		throw new Error(
			`Qualified tool name "${requestedTool}" is ambiguous. Call with { server: "<server>", tool: "<tool>", args: {} }.`,
		);
	}
	if (qualified.length === 1) return qualified[0];

	const unprefixed = availableTools.filter((candidate) => candidate.toolName === requestedTool);
	if (unprefixed.length > 1) {
		throw new Error(
			`Tool "${requestedTool}" exists on multiple servers: ${unprefixed.map((item) => item.serverName).join(", ")}. Call with { server: "<server>", tool: "${requestedTool}", args: {} }.`,
		);
	}
	return unprefixed[0] ?? null;
}

function formatMcpToolResultSummary(content: any[], theme: any): string {
	if (!content || content.length === 0) {
		return theme.fg("dim", "No output returned.");
	}

	const textItem = content.find((item) => item.type === "text");
	if (!textItem || !textItem.text) {
		return theme.fg("dim", `Returned non-text content (${content.length} items)`);
	}

	const rawText = textItem.text;
	const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");

	try {
		const parsed = JSON.parse(rawText);
		const sizeStr = theme.fg("syntaxComment", `(${(rawText.length / 1024).toFixed(2)} KB)`);

		if (Array.isArray(parsed)) {
			return (
				successPrefix +
				theme.fg("text", "Returned array with ") +
				theme.fg("accent", `${parsed.length}`) +
				theme.fg("text", " items ") +
				sizeStr
			);
		} else if (parsed && typeof parsed === "object") {
			if (Array.isArray(parsed.data)) {
				const itemsCount = parsed.data.length;
				const names = parsed.data
					.map((item: any) => item.name || item.title || item.id)
					.filter(Boolean)
					.slice(0, 3)
					.join(", ");
				const namesStr = names ? ` (${names}${parsed.data.length > 3 ? "..." : ""})` : "";
				return (
					successPrefix +
					theme.fg("text", "Returned ") +
					theme.fg("accent", `${itemsCount}`) +
					theme.fg("text", ` items${namesStr} `) +
					sizeStr
				);
			} else if (parsed.content && Array.isArray(parsed.content)) {
				return (
					successPrefix +
					theme.fg("text", "Returned ") +
					theme.fg("accent", `${parsed.content.length}`) +
					theme.fg("text", " sub-items ") +
					sizeStr
				);
			}
			const keysCount = Object.keys(parsed).length;
			return (
				successPrefix +
				theme.fg("text", "Returned JSON object with ") +
				theme.fg("accent", `${keysCount}`) +
				theme.fg("text", " keys ") +
				sizeStr
			);
		}
	} catch (_e) {
		// Non-JSON
	}

	const lineCount = rawText.split("\n").length;
	const sizeKb = (rawText.length / 1024).toFixed(2);
	return (
		successPrefix +
		theme.fg("text", `Returned text: `) +
		theme.fg("accent", `${lineCount}`) +
		theme.fg("text", ` lines `) +
		theme.fg("syntaxComment", `(${sizeKb} KB)`)
	);
}

export default function mcpKit(pi: ExtensionAPI) {
	const config = loadMcpConfig();
	const cache = loadMetadataCache();
	const serverNames = Object.keys(config.mcpServers);

	const toolCount = serverNames.reduce(
		(count, name) => count + (getActiveCacheEntry(cache, config, name)?.tools.length ?? 0),
		0,
	);
	const gatewayDescription = `Discover and execute tools from configured MCP servers (${serverNames.length} servers, ${toolCount} cached tools).`;
	const detailedPromptSnippet =
		'Discover MCP capabilities with { search: "<task>" }, then call an exact returned tool name with { tool, args }. ' +
		"Use { status: true } for a compact live dashboard. Never guess or autocorrect mutation tool names.";

	// 1. Session Start
	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		const cwd = safeCwd(ctx.cwd);
		writeLog(
			`Session started in CWD: ${cwd}. Project trust: ${ctx.isProjectTrusted() ? "trusted" : "untrusted"}.`,
			"INFO",
		);
	});

	// 2. Session Shutdown
	pi.on("session_shutdown", async () => {
		const pool = McpClientPool.getInstance();
		await pool.closeAll();
		await cleanupSpilledTempDirs();
		writeLog("Session shutdown. Cleaned up MCP Kit connection pool and spilled temp dirs.", "INFO");
	});

	// 3. Register Gateway Tool (mcp)
	(pi.registerTool as any)({
		name: "mcp",
		label: "MCP Kit",
		description: gatewayDescription,
		promptSnippet: detailedPromptSnippet,
		parameters: Type.Object({
			tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'API-list-spaces')" })),
			args: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "JSON object matching the selected MCP tool's input schema.",
				}),
			),
			connect: Type.Optional(
				Type.String({ description: "Server name to manually connect / refresh tool metadata" }),
			),
			search: Type.Optional(Type.String({ description: "Search tools in cache by keyword" })),
			status: Type.Optional(Type.Boolean({ description: "Get connection status of all configured servers" })),
			resourceList: Type.Optional(
				Type.Boolean({ description: "List resources on specified server (requires 'server')" }),
			),
			resourceRead: Type.Optional(
				Type.String({ description: "Read resource by URI on specified server (requires 'server')" }),
			),
			server: Type.Optional(
				Type.String({ description: "Exact server for tool disambiguation or resource operations" }),
			),
		}),
		prepareArguments(args: unknown) {
			if (!args || typeof args !== "object") return args;
			const input = args as { args?: unknown };
			if (typeof input.args !== "string") return args;
			try {
				return { ...input, args: JSON.parse(input.args) };
			} catch {
				return args;
			}
		},
		executionMode: "parallel" as const,
		async execute(
			_toolCallId: string,
			params: {
				tool?: string;
				args?: any;
				connect?: string;
				search?: string;
				status?: boolean;
				resourceList?: boolean;
				resourceRead?: string;
				server?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: (msg: { content: Array<{ type: "text"; text: string }> }) => void,
			ctx: ExtensionContext,
		) {
			signal?.throwIfAborted();
			const pool = McpClientPool.getInstance();
			const currentCwd = safeCwd(ctx.cwd);
			const activeConfig = loadMcpConfig(undefined, currentCwd, ctx.isProjectTrusted?.() === true);
			const actionCount = [
				params.tool,
				params.connect,
				params.search,
				params.status,
				params.resourceList,
				params.resourceRead,
			].filter(Boolean).length;
			if (actionCount > 1) {
				throw new Error(
					"Specify exactly one MCP action: tool, connect, search, status, resourceList, or resourceRead.",
				);
			}

			// Action: Connect / Force Refresh
			if (params.connect) {
				const serverName = params.connect;
				pool.resetServerHealth(serverName);
				const serverDef = activeConfig.mcpServers[serverName];
				if (!serverDef) {
					throw new Error(`Server "${serverName}" is not configured.`);
				}

				try {
					if (onUpdate) onUpdate({ content: [{ type: "text", text: `Connecting to "${serverName}"...` }] });

					const client = await pool.getClient(serverName, serverDef, activeConfig.settings?.debug, signal);
					const { tools, resources } = await refreshServerMetadata(serverName, serverDef, client, signal);

					return {
						content: [
							{
								type: "text",
								text: `Connected "${serverName}": ${tools.length} tools, ${resources.length} resources.\nhelp[1]: Search capabilities with { search: "<task>" }.`,
							},
						],
						details: { status: "connected", serverName, toolsCount: tools.length },
					};
				} catch (err: any) {
					throw new Error(`Failed to connect "${serverName}": ${err.message}`, { cause: err });
				}
			}

			// Action: Search Cache
			if (params.search) {
				const keyword = params.search.toLowerCase();
				const activeCache = loadMetadataCache();
				const matchedTools: any[] = [];

				for (const serverName of Object.keys(activeConfig.mcpServers)) {
					const entry = getActiveCacheEntry(activeCache, activeConfig, serverName);
					if (!entry) continue;
					const matched = entry.tools.filter(
						(t) => t.name.toLowerCase().includes(keyword) || t.description?.toLowerCase().includes(keyword),
					);
					if (matched.length > 0) {
						matchedTools.push({
							server: serverName,
							tools: matched,
						});
					}
				}

				const flatMatches = matchedTools.flatMap((group) =>
					group.tools.map((tool: any) => ({ server: group.server, tool })),
				);
				const rows = flatMatches
					.slice(0, 5)
					.map(({ server, tool }: any) => {
						const properties = tool.inputSchema?.properties ?? {};
						const required = new Set(tool.inputSchema?.required ?? []);
						const params = Object.entries(properties)
							.map(
								([name, schema]: [string, any]) =>
									`${name}${required.has(name) ? "*" : ""}:${schema.type ?? "any"}`,
							)
							.join("|");
						return `  ${server}-${tool.name},${JSON.stringify(params)},${JSON.stringify(cleanDescription(tool.description))}`;
					})
					.join("\n");
				const text =
					flatMatches.length === 0
						? `0 tools match "${params.search}".\nhelp[1]: Refresh a server with { connect: "<server>" }.`
						: `tools[${flatMatches.length}]{name,params,description}:\n${rows}\n(* = required)\nhelp[1]: Call an exact name with { tool: "<server-tool>", args: {} }.`;
				return {
					content: [{ type: "text", text }],
					details: { count: flatMatches.length },
				};
			}

			// Action: Status
			if (params.status) {
				const activeCache = loadMetadataCache();
				const activeClients = pool.getActiveClients();
				const statuses = Object.keys(activeConfig.mcpServers).map((name) => {
					const isLive = pool.isClientActive(name, activeConfig.mcpServers[name]);
					const entry = getActiveCacheEntry(activeCache, activeConfig, name);
					const cachedCount = entry?.tools.length ?? 0;
					return {
						name,
						status: isLive ? "LIVE" : "LAZY",
						cachedToolsCount: cachedCount,
					};
				});

				const rows = statuses
					.map((status) => `  ${status.name},${status.status},${status.cachedToolsCount}`)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text:
								statuses.length === 0
									? "0 MCP servers configured."
									: `servers[${statuses.length}]{name,status,cachedTools}:\n${rows}\nhelp[1]: Search tools with { search: "<task>" }.`,
						},
					],
					details: { activeClients, statuses },
				};
			}

			// Action: Resource List / Resource Read
			if (params.resourceList || params.resourceRead) {
				if (!params.server) {
					throw new Error("'server' is required when listing or reading resources.");
				}

				const { handleMcpResourceProxy } = await import("./proxy.js");
				return await handleMcpResourceProxy(
					{
						server: params.server,
						resourceList: params.resourceList,
						resourceRead: params.resourceRead,
					},
					activeConfig,
					activeConfig.settings?.debug,
					signal,
				);
			}

			// Action: Tool Execution (With transparent lazy connect and parameter auto-parsing)
			if (params.tool) {
				const toolName = params.tool;
				const activeCache = loadMetadataCache();

				let targetServerName: string | null = null;
				let realToolName = toolName;
				const availableTools = Object.keys(activeConfig.mcpServers).flatMap((serverName) => {
					const entry = getActiveCacheEntry(activeCache, activeConfig, serverName);
					return entry ? entry.tools.map((tool) => ({ serverName, toolName: tool.name })) : [];
				});

				if (params.server && !activeConfig.mcpServers[params.server]) {
					throw new Error(`Server "${params.server}" is not configured.`);
				}
				const exact = resolveToolTarget(availableTools, toolName, params.server);
				if (params.server && !exact) {
					throw new Error(`Tool "${toolName}" is not cached on server "${params.server}".`);
				}
				if (exact) {
					targetServerName = exact.serverName;
					realToolName = exact.toolName;
				}

				// Unknown names fail loud. Similarity is used only for suggestions and
				// never to execute a potentially destructive mutation.
				if (!targetServerName) {
					const candidates = Object.keys(activeConfig.mcpServers)
						.flatMap((serverName) => {
							const entry = getActiveCacheEntry(activeCache, activeConfig, serverName);
							return (entry?.tools ?? []).map((tool) => ({
								name: `${serverName}-${tool.name}`,
								description: cleanDescription(tool.description),
								score: getSimilarity(toolName, `${serverName}-${tool.name}`),
							}));
						})
						.filter((candidate) => candidate.score >= 0.5)
						.sort((a, b) => b.score - a.score)
						.slice(0, 3);
					const suggestions = candidates.length
						? ` Did you mean: ${candidates.map((candidate) => `"${candidate.name}"`).join(", ")}?`
						: "";
					throw new Error(
						`Tool "${toolName}" not found in cache.${suggestions} Search with { search: "<task>" } or refresh with { connect: "<server>" }.`,
					);
				}

				// Bidirectional adaptation: parse JSON string if string; forward directly if object
				let parsedArgs: Record<string, any> = {};
				if (params.args) {
					if (typeof params.args === "string") {
						try {
							parsedArgs = JSON.parse(params.args);
						} catch (err: any) {
							throw new Error(`Invalid arguments JSON for tool "${toolName}": ${err.message}`, { cause: err });
						}
					} else if (typeof params.args === "object") {
						parsedArgs = params.args;
					}
				}

				if (onUpdate) {
					try {
						onUpdate({
							content: [
								{
									type: "text",
									text: `Routing "${toolName}" to server "${targetServerName}" (tool: "${realToolName}")...`,
								},
							],
						});
					} catch {}
				}

				// Concurrency scheduling based on read-only semantics
				const serverCache = getActiveCacheEntry(activeCache, activeConfig, targetServerName || "");
				const foundTool = serverCache?.tools.find((t: any) => t.name === realToolName);
				const mode = foundTool ? classifyExecutionMode(foundTool) : "sequential";

				if (mode === "sequential") {
					const targetDefinition = activeConfig.mcpServers[targetServerName!];
					const lock = pool.getMutex(targetServerName!, targetDefinition);
					const release = await lock.lock(signal);
					try {
						return await handleMcpProxy(
							{
								server: targetServerName,
								tool: realToolName,
								toolDefinition: foundTool,
								args: parsedArgs,
							},
							activeConfig,
							activeConfig.settings?.debug,
							signal,
						);
					} finally {
						release();
					}
				}

				// Forward to proxy layer for lazy client acquisition, argument bundling, and response normalization
				return await handleMcpProxy(
					{
						server: targetServerName,
						tool: realToolName,
						toolDefinition: foundTool,
						args: parsedArgs,
					},
					activeConfig,
					activeConfig.settings?.debug,
					signal,
				);
			}

			const homeRows = Object.keys(activeConfig.mcpServers)
				.map((name) => {
					const count = getActiveCacheEntry(loadMetadataCache(), activeConfig, name)?.tools.length ?? 0;
					const isLive = pool.isClientActive(name, activeConfig.mcpServers[name]);
					return `  ${name},${isLive ? "LIVE" : "LAZY"},${count}`;
				})
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: homeRows
							? `servers[${Object.keys(activeConfig.mcpServers).length}]{name,status,cachedTools}:\n${homeRows}\nhelp[2]:\n  Search with { search: "<task>" }.\n  Refresh with { connect: "<server>" }.`
							: "0 MCP servers configured. Add a server to the global MCP configuration, then retry.",
					},
				],
				details: {},
			};
		},
		renderCall(args: any, theme: any, _context: any) {
			let text = theme.fg("toolTitle", theme.bold("mcp "));
			if (args.tool) {
				text += theme.fg("muted", `call `) + theme.fg("accent", args.tool);
				if (args.args) {
					const rawArgs = typeof args.args === "object" ? JSON.stringify(args.args) : String(args.args);
					const trimmedArgs = rawArgs.length > 60 ? `${rawArgs.substring(0, 57)}...` : rawArgs;
					text += ` ${theme.fg("dim", trimmedArgs)}`;
				}
			} else if (args.connect) {
				text += theme.fg("muted", `connect `) + theme.fg("accent", args.connect);
			} else if (args.search) {
				text += theme.fg("muted", `search `) + theme.fg("accent", `"${args.search}"`);
			} else if (args.status) {
				text += theme.fg("muted", `status`);
			} else if (args.resourceList) {
				text += theme.fg("muted", `resources `) + theme.fg("accent", args.server || "unknown");
			} else if (args.resourceRead) {
				text += theme.fg("muted", `read-resource `) + theme.fg("accent", args.resourceRead);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const args = context.args || {};

			if (result.details?.error) {
				return new Text(theme.fg("error", `Error: ${result.details.message || result.details.error}`), 0, 0);
			}

			if (args.connect) {
				const text = result.content?.[0]?.text || "";
				return new Text(text, 0, 0);
			}

			if (args.search) {
				return new Text(result.content?.[0]?.text || "", 0, 0);
			}

			if (args.status) {
				const text = result.content?.[0]?.text || "";
				return new Text(text, 0, 0);
			}

			if (args.tool) {
				const textItem = result.content?.find((item: any) => item.type === "text");
				const rawText = textItem?.text || "";

				if (!expanded) {
					const summary = formatMcpToolResultSummary(result.content || [], theme);
					const hint = keyHint("app.tools.expand", "to expand");
					return new Text(`${summary} ${theme.fg("syntaxComment", `(${hint})`)}`, 0, 0);
				} else {
					if (!rawText) {
						return new Text(theme.fg("dim", "No output returned."), 0, 0);
					}

					let displayText = rawText;
					try {
						const parsed = JSON.parse(rawText);
						displayText = JSON.stringify(parsed, null, 2);
					} catch (_e) {
						// Keep plain
					}

					const lines = displayText.split("\n");
					if (lines.length > 100) {
						displayText =
							lines.slice(0, 100).join("\n") +
							`\n\n${theme.fg("warning", `... Truncated ${lines.length - 100} lines of output. ...`)}`;
					}

					return new Text(displayText, 0, 0);
				}
			}

			if (args.resourceList) {
				const serverName = args.server || "unknown";
				const resources = result.details?.resources || [];
				if (!expanded) {
					const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");
					const hint = keyHint("app.tools.expand", "to expand");
					return new Text(
						successPrefix +
							theme.fg("text", `Returned `) +
							theme.fg("accent", `${resources.length}`) +
							theme.fg("text", ` resources on server "${serverName}" `) +
							theme.fg("syntaxComment", `(${hint})`),
						0,
						0,
					);
				} else {
					if (resources.length === 0) {
						return new Text(theme.fg("dim", `No resources available on server "${serverName}".`), 0, 0);
					}
					let listText = theme.fg("accent", theme.bold(`[${serverName}] Resources:`));
					resources.forEach((r: any) => {
						const cleanedDesc = cleanDescription(r.description);
						listText += `\n  ${theme.fg("success", "•")} ${theme.fg("toolTitle", r.name)} ${theme.fg("muted", `(${r.uri})`)}`;
						if (r.description) {
							listText += `\n    ${theme.fg("syntaxComment", cleanedDesc)}`;
						}
					});
					return new Text(listText, 0, 0);
				}
			}

			if (args.resourceRead) {
				const serverName = args.server || "unknown";
				const resourceUri = args.resourceRead;
				const textItem = result.content?.find((item: any) => item.type === "text");
				const rawText = textItem?.text || "";

				if (!expanded) {
					const successPrefix = theme.fg("success", "Success") + theme.fg("text", " | ");
					const sizeKb = ((rawText || "").length / 1024).toFixed(2);
					const hint = keyHint("app.tools.expand", "to expand");
					return new Text(
						successPrefix +
							theme.fg("text", `Successfully read resource `) +
							theme.fg("accent", `"${resourceUri}"`) +
							theme.fg("text", ` on "${serverName}" `) +
							theme.fg("syntaxComment", `(${sizeKb} KB) (${hint})`),
						0,
						0,
					);
				} else {
					if (!rawText) {
						return new Text(theme.fg("dim", "Resource is empty or has no text content."), 0, 0);
					}

					let displayText = rawText;
					const lines = displayText.split("\n");
					if (lines.length > 100) {
						displayText =
							lines.slice(0, 100).join("\n") +
							`\n\n${theme.fg("warning", `... Truncated ${lines.length - 100} lines of resource content. ...`)}`;
					}
					return new Text(displayText, 0, 0);
				}
			}

			const text = result.content?.[0]?.text || "";
			return new Text(text, 0, 0);
		},
	});

	// 4. Command /mcp (Interactive Terminal Control Panel)
	pi.registerCommand("mcp", {
		description: "Manage Pi MCP Kit Connections",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim().toLowerCase();
			const pool = McpClientPool.getInstance();
			const activeClients = pool.getActiveClients();

			const matches = serverNames
				.filter((name) => name.toLowerCase().startsWith(trimmed))
				.map((name) => {
					const isLive = activeClients.includes(name);
					return {
						value: name,
						label: isLive ? `${name}  ✓` : name,
					};
				});
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string | undefined, ctx: any) => {
			const pool = McpClientPool.getInstance();
			const commandConfig = loadMcpConfig(undefined, safeCwd(ctx.cwd), ctx.isProjectTrusted?.() === true);
			const commandServerNames = Object.keys(commandConfig.mcpServers);
			const argv = args?.trim().split(/\s+/) || [];
			const subcommand = argv[0] || "";
			const isReconnect = subcommand === "reconnect" || subcommand === "refresh";
			const targetName = isReconnect ? argv[1] || "" : subcommand;

			if (subcommand === "help") {
				const helpMsg = `Pi MCP Kit Commands:
  /mcp                         - Open interactive MCP server control panel (TUI)
  /mcp <serverName>            - Toggle connect/disconnect for a server
  /mcp reconnect <serverName>  - Reconnect and refresh metadata for a server`;
				if (ctx.hasUI) ctx.ui.notify(helpMsg, "info");
				else console.log(helpMsg);
				return;
			}

			if (commandServerNames.includes(targetName)) {
				const target = targetName;
				const activeConfig = commandConfig;
				const targetDef = activeConfig.mcpServers[target];
				const isCurrentlyLive = pool.isClientActive(target, targetDef);

				try {
					if (isCurrentlyLive) {
						if (ctx.hasUI) {
							ctx.ui.setStatus("mcp", `Closing "${target}"...`);
							ctx.ui.notify(`Closing connection to "${target}"...`, "info");
						} else {
							console.log(`Closing connection to "${target}"...`);
						}

						await pool.closeClient(target, targetDef);

						if (ctx.hasUI) {
							ctx.ui.setStatus("mcp", "");
							ctx.ui.notify(`Closed connection to "${target}"`, "info");
						} else {
							console.log(`Closed connection to "${target}"`);
						}
					}
					if (!isCurrentlyLive || isReconnect) {
						pool.resetServerHealth(target, targetDef);
						if (ctx.hasUI) {
							ctx.ui.setStatus("mcp", `Connecting to "${target}"...`);
							ctx.ui.notify(`Connecting to "${target}" and refreshing tools...`, "info");
						} else {
							console.log(`Connecting to "${target}"...`);
						}

						const client = await pool.getClient(target, targetDef, activeConfig.settings?.debug);
						await refreshServerMetadata(target, targetDef, client);

						if (ctx.hasUI) {
							ctx.ui.setStatus("mcp", "");
							ctx.ui.notify(`Connected and synced "${target}" successfully!`, "info");
						} else {
							console.log(`Connected and synced "${target}" successfully!`);
						}
					}
				} catch (err: any) {
					if (ctx.hasUI) {
						ctx.ui.setStatus("mcp", "");
						ctx.ui.notify(`Connection failed for "${target}": ${err.message}`, "error");
					} else {
						console.error(`Connection failed for "${target}": ${err.message}`);
					}
				}
				return;
			}

			if (ctx.hasUI && subcommand === "") {
				await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
					const activeCache = loadMetadataCache();

					const getItems = (): SettingItem[] => {
						const activeConfig = loadMcpConfig(undefined, safeCwd(ctx.cwd), ctx.isProjectTrusted?.() === true);
						const currentNames = Object.keys(activeConfig.mcpServers);

						return currentNames.map((name) => {
							const definition = activeConfig.mcpServers[name];
							const isLive = pool.isClientActive(name, definition);
							const entry = getActiveCacheEntry(activeCache, activeConfig, name);
							const cachedCount = entry?.tools.length ?? 0;
							const cmd =
								activeConfig.mcpServers[name]?.command || activeConfig.mcpServers[name]?.url || "unknown";

							return {
								id: name,
								label: name,
								description: `Cached: ${cachedCount} tools. Service: ${cmd}`,
								currentValue: isLive ? `\x1b[32m✓\x1b[0m` : "",
								values: isLive ? ["close", "reconnect", "✓"] : ["connect", ""],
							};
						});
					};

					const items = getItems();

					const settingsList = new SettingsList(
						items,
						Math.min(items.length + 2, 12),
						getSettingsListTheme(),
						async (id: string, newValue: any) => {
							const activeConfig = loadMcpConfig(undefined, safeCwd(ctx.cwd), ctx.isProjectTrusted?.() === true);
							const targetDef = activeConfig.mcpServers[id];

							try {
								if (newValue === "connect" || newValue === "reconnect") {
									if (!targetDef) throw new Error(`Server "${id}" is not configured.`);
									pool.resetServerHealth(id, targetDef);
									await pool.closeClient(id, targetDef);
									if (targetDef) {
										const client = await pool.getClient(id, targetDef, activeConfig.settings?.debug);
										await refreshServerMetadata(id, targetDef, client);
										ctx.ui.notify(`Connected to "${id}" successfully.`, "info");
									}
								} else if (newValue === "close") {
									await pool.closeClient(id, targetDef);
									ctx.ui.notify(`Closed server "${id}" connection.`, "info");
								}
							} catch (err: any) {
								ctx.ui.notify(`Action failed on "${id}": ${err.message}`, "error");
							} finally {
								const refreshedItems = getItems();
								refreshedItems.forEach((refItem, index) => {
									if (items[index]) {
										items[index].currentValue = refItem.currentValue;
										items[index].values = refItem.values;
										items[index].description = refItem.description;
									}
								});
								tui.requestRender();
							}
						},
						() => {
							done(undefined);
						},
						{ enableSearch: true },
					);

					return {
						render(width: number) {
							const listLines = settingsList.render(width);
							const borderLine = theme.fg("border", "─".repeat(width));
							const titleLines = [
								borderLine,
								"",
								` ${theme.fg("accent", theme.bold("MCP Server Configuration"))}`,
								"",
							];
							return [...titleLines, ...listLines, "", borderLine];
						},
						invalidate() {
							settingsList.invalidate?.();
						},
						handleInput(data: string) {
							settingsList.handleInput?.(data);
							tui.requestRender();
						},
					};
				});
				return;
			}

			if (subcommand === "") {
				const helpMsg = `Pi MCP Kit:\n  Please run /mcp in UI to open interactive control panel.\n  Or run /mcp <serverName> to toggle connection.`;
				console.log(helpMsg);
				return;
			}

			const errorMsg = `Unknown subcommand "${subcommand}".\nUse "/mcp help" to see available commands.`;
			if (ctx.hasUI) ctx.ui.notify(errorMsg, "error");
			else console.log(errorMsg);
		},
	});
}

function safeCwd(cwd?: string): string {
	if (!cwd) return process.cwd();
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}
