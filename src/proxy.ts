// proxy.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { McpClientPool } from "./client.js";
import { writeLog } from "./logger.js";
import type { McpConfig, McpProxyArgs } from "./types.js";
import { McpError, McpErrorCode } from "./types.js";

export interface LimitedMcpText {
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const spilledTempDirs = new Set<string>();

async function spillMcpOutput(content: string, filename = "content.txt"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
	spilledTempDirs.add(dir);
	const fullOutputPath = join(dir, filename);
	await writeFile(fullOutputPath, content, "utf8");
	return fullOutputPath;
}

export async function cleanupSpilledTempDirs(): Promise<void> {
	for (const dir of Array.from(spilledTempDirs)) {
		try {
			await rm(dir, { recursive: true, force: true });
			spilledTempDirs.delete(dir);
		} catch (err) {
			writeLog(`Failed to remove spilled temp dir ${dir}: ${err}`, "WARN");
		}
	}
}

export async function limitMcpText(text: string): Promise<LimitedMcpText> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text };

	const fullOutputPath = await spillMcpOutput(text);
	return {
		text:
			truncation.content +
			`\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines` +
			` (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}).` +
			` Full output: ${fullOutputPath}]`,
		truncation,
		fullOutputPath,
	};
}

export async function normalizeMcpResponse(response: any): Promise<any> {
	if (response?.isError) {
		const message = Array.isArray(response.content)
			? response.content
					.map((item: any) => item?.text)
					.filter(Boolean)
					.join("\n")
			: "MCP server returned an error";
		throw new Error(message || "MCP server returned an error");
	}

	const originalContent = Array.isArray(response?.content)
		? response.content
		: [{ type: "text", text: typeof response === "object" ? JSON.stringify(response) : String(response) }];
	const nonText = originalContent.filter((item: any) => item?.type !== "text");
	const joinedText = originalContent
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item.text ?? ""))
		.join("\n\n");
	const text =
		joinedText ||
		(nonText.length > 0
			? `Returned ${nonText.length} non-text content item(s).`
			: "0 content items returned by MCP tool.");
	const serializedNonText = JSON.stringify(nonText);
	if (Buffer.byteLength(text, "utf8") + Buffer.byteLength(serializedNonText, "utf8") > DEFAULT_MAX_BYTES) {
		const fullOutputPath = await spillMcpOutput(JSON.stringify(response, null, 2), "response.json");
		const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		return {
			content: [
				{
					type: "text",
					text: `${truncation.content}\n\n[Non-text content omitted to stay within the tool output budget. Full response: ${fullOutputPath}]`,
				},
			],
			details: { truncation: truncation.truncated ? truncation : undefined, fullOutputPath },
		};
	}
	const limited = await limitMcpText(text);
	return {
		content: [{ type: "text", text: limited.text }, ...nonText],
		details: {
			truncation: limited.truncation,
			fullOutputPath: limited.fullOutputPath,
		},
	};
}

/**
 * Core proxy dispatcher: routes tool calls to the correct MCP server.
 *
 * Automatically resolves server prefixes (`serverName_toolName` or
 * `serverName-toolName`), lazily starts server processes via the pool,
 * and wraps results in Pi-compatible `{ content: [...] }` format.
 *
 * @param proxyArgs `{ server, tool, args }` — the server, tool name, and parameters
 * @param config Full MCP configuration (server definitions)
 * @param debug Enable verbose logging
 * @returns Pi-compatible tool result
 */
export async function handleMcpProxy(
	proxyArgs: McpProxyArgs,
	config: McpConfig,
	debug = false,
	signal?: AbortSignal,
): Promise<any> {
	const { server, tool, toolDefinition, args = {} } = proxyArgs;

	if (!server) {
		throw new Error("Missing 'server' field in MCP proxy call.");
	}
	if (!tool) {
		throw new Error("Missing 'tool' field in MCP proxy call.");
	}

	// 1. Retrieve server definition
	const serverDef = config.mcpServers[server];
	if (!serverDef) {
		const available = Object.keys(config.mcpServers).join(", ") || "none";
		throw new Error(`MCP server "${server}" is not configured. Available servers: ${available}`);
	}

	try {
		// 2. Acquire client from lightweight pool with concurrency locking
		const pool = McpClientPool.getInstance();
		const client = await pool.getClient(server, serverDef, debug, signal);

		client.onInputRequired = async (toolName, inputRequests) => {
			throw new McpError(
				`Tool "${toolName}" requires additional input:\n` +
					inputRequests.map((r) => `  - ${r.name}: ${r.description || "no description"}`).join("\n") +
					`\n\nRetry with the required input fields added to args.`,
				McpErrorCode.INPUT_REQUIRED,
			);
		};

		// 3. Dispatch tool execution
		writeLog(`[Proxy] Routing tool call "${tool}" to server "${server}"...`, "INFO");
		const response = await client.callTool(tool, args, toolDefinition, signal);

		return await normalizeMcpResponse(response);
	} catch (err: any) {
		writeLog(`[Proxy] Failed to execute "${tool}" on "${server}": ${err.message}`, "ERROR");
		throw new Error(`[MCP Error on "${server}"] ${err.message}`, { cause: err });
	}
}

/**
 * MCP resource proxy dispatch handler.
 */
export async function handleMcpResourceProxy(
	proxyArgs: McpProxyArgs,
	config: McpConfig,
	debug = false,
	signal?: AbortSignal,
): Promise<any> {
	const { server, resourceList, resourceRead } = proxyArgs;

	if (!server) {
		throw new Error("Missing 'server' field in MCP proxy call.");
	}

	const serverDef = config.mcpServers[server];
	if (!serverDef) {
		const available = Object.keys(config.mcpServers).join(", ") || "none";
		throw new Error(`MCP server "${server}" is not configured. Available servers: ${available}`);
	}

	try {
		const pool = McpClientPool.getInstance();
		const client = await pool.getClient(server, serverDef, debug, signal);

		if (resourceList) {
			writeLog(`[Proxy] Listing resources on server "${server}"...`, "INFO");
			const resources = await client.listResources(signal);
			const summary =
				resources.length === 0
					? `0 resources on server "${server}".`
					: `resources[${resources.length}]{name,uri}:\n${resources
							.map(
								(resource: any) =>
									`  ${JSON.stringify(resource.name ?? "")},${JSON.stringify(resource.uri ?? "")}`,
							)
							.join("\n")}\nhelp[1]: Read one with { server: "${server}", resourceRead: "<uri>" }`;
			const limited = await limitMcpText(summary);
			return {
				content: [{ type: "text", text: limited.text }],
				details: {
					status: "success",
					server,
					resources,
					truncation: limited.truncation,
					fullOutputPath: limited.fullOutputPath,
				},
			};
		}

		if (resourceRead) {
			writeLog(`[Proxy] Reading resource "${resourceRead}" from server "${server}"...`, "INFO");
			const response = await client.readResource(resourceRead, signal);

			const text =
				response && Array.isArray(response.contents)
					? response.contents
							.map(
								(item: any) =>
									item.text || (item.blob ? Buffer.from(item.blob, "base64").toString("utf-8") : ""),
							)
							.join("\n\n")
					: typeof response === "object"
						? JSON.stringify(response)
						: String(response);
			const limited = await limitMcpText(text);
			return {
				content: [{ type: "text", text: limited.text }],
				details: {
					status: "success",
					server,
					resource: resourceRead,
					truncation: limited.truncation,
					fullOutputPath: limited.fullOutputPath,
				},
			};
		}

		throw new Error("Invalid resource proxy call: neither 'resourceList' nor 'resourceRead' specified.");
	} catch (err: any) {
		writeLog(`[Proxy] Resource operation failed on "${server}": ${err.message}`, "ERROR");
		throw new Error(`[MCP Resource Error on "${server}"] ${err.message}`, { cause: err });
	}
}
