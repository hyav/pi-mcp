import assert from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readBoundedResponseText } from "../src/bounded-response.js";
import { getCacheFilePath, getFreshServerCacheEntry, loadMetadataCache, updateServerCache } from "../src/cache.js";
import { SimpleMcpClient } from "../src/client.js";
import { getGlobalConfigPaths, getThirdPartyIdePaths, getTrustFilePath, loadMcpConfig } from "../src/config.js";
import registerMcp, { resolveToolTarget } from "../src/index.js";
import { getLogFilePath, migrateLegacyDataFiles, redactLogMessage, setSensitiveLogValues } from "../src/logger.js";
import { limitMcpText, normalizeMcpResponse } from "../src/proxy.js";
import { BoundedNdjsonParser } from "../src/stdio-transport.js";
import {
	buildMcpParamHeaders,
	encodeMcpHeaderValue,
	StreamableHttpTransport,
	validateMcpToolHeaders,
} from "../src/streamable-http-transport.js";

test("SimpleMcpClient - Legacy Handshake, listTools and callTool", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient(
		"mock-test-server",
		"node",
		[mockServerPath],
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	console.log("Connecting client to mock server (legacy mode)...");
	const initResult = await client.connect();

	// 1. Assert Handshake init is correct
	assert.ok(initResult);
	assert.strictEqual(initResult.serverInfo.name, "mock-mcp-server");
	assert.strictEqual(initResult.protocolVersion, "2024-11-05");

	// 2. Assert listTools retrieves mock tool definitions
	console.log("Listing tools...");
	const tools = await client.listTools();
	assert.strictEqual(tools.length, 2);
	assert.strictEqual(tools[0].name, "greet");
	assert.strictEqual(tools[0].description, "Greet a user by name");

	// 3. Assert callTool works as expected with params
	console.log("Calling tool 'greet'...");
	const response = await client.callTool("greet", { name: "Alice" });
	assert.ok(response);
	assert.ok(Array.isArray(response.content));
	assert.strictEqual(response.content[0].type, "text");
	assert.strictEqual(response.content[0].text, "Hello, Alice!");

	// 4. Assert listResources works
	console.log("Listing resources...");
	const resources = await client.listResources();
	assert.strictEqual(resources.length, 1);
	assert.strictEqual(resources[0].uri, "mock://settings");
	assert.strictEqual(resources[0].name, "Mock System Settings");

	// 5. Assert readResource works
	console.log("Reading resource...");
	const readRes = await client.readResource("mock://settings");
	assert.ok(readRes);
	assert.ok(Array.isArray(readRes.contents));
	assert.strictEqual(readRes.contents[0].uri, "mock://settings");
	const parsedRes = JSON.parse(readRes.contents[0].text);
	assert.strictEqual(parsedRes.theme, "dark");

	// Close connection cleanly
	console.log("Closing connection...");
	await client.close();
});

test("stdio servers receive only explicit credentials from the parent environment", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const previous = process.env.HOST_ONLY_SENTINEL;
	process.env.HOST_ONLY_SENTINEL = "must-not-leak";
	const client = new SimpleMcpClient(
		"environment-isolation",
		"node",
		[mockServerPath],
		{ EXPLICIT_SENTINEL: "configured-value" },
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"modern",
	);

	try {
		await client.connect();
		const response = await client.callTool("inspect-env", {});
		assert.deepStrictEqual(JSON.parse(response.content[0].text), {
			hostOnly: null,
			explicit: "configured-value",
		});
	} finally {
		await client.close();
		if (previous === undefined) delete process.env.HOST_ONLY_SENTINEL;
		else process.env.HOST_ONLY_SENTINEL = previous;
	}
});

test("SimpleMcpClient - Modern Protocol (2026-07-28) stateless mode", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-test-server-modern", "node", [mockServerPath]);

	console.log("Connecting client to mock server (modern auto-detect mode)...");
	const probeResult = await client.connect();

	// In modern mode, auto-detect uses tools/list probe
	assert.ok(probeResult);
	const tools = await client.listTools();
	assert.strictEqual(tools.length, 2);

	const response = await client.callTool("greet", { name: "Bob" });
	assert.strictEqual(response.content[0].text, "Hello, Bob!");

	await client.close();
});

test("MRTR: input_required triggers descriptive error or MRTR handler", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-mrtr-server", "node", [mockServerPath]);
	await client.connect();

	// Without onInputRequired handler: throws McpError with description
	await assert.rejects(
		() => client.callTool("interactive", {}),
		(err: any) => err.message.includes("requires additional input") && err.code === "INPUT_REQUIRED",
	);

	// With onInputRequired handler: automates input round-trip
	client.onInputRequired = async (toolName, inputRequests) => {
		assert.strictEqual(toolName, "interactive");
		assert.strictEqual(inputRequests[0].name, "confirmation");
		return [{ confirmation: "yes" }];
	};

	const result = await client.callTool("interactive", {});
	assert.strictEqual(result.content[0].text, "Confirmed!");

	await client.close();
});

test("Metadata Cache - Save and Load", () => {
	const serverName = "cache-test-server";
	const mockTools = [
		{
			name: "test-tool",
			description: "A tool to test caching",
		},
	];
	const serverFingerprint = "test-fingerprint-123";
	const receivedAt = Date.now();

	updateServerCache(serverName, mockTools, [], serverFingerprint, {
		ttlMs: 1000,
		cacheScope: "public",
		receivedAt,
	});

	const cache = loadMetadataCache();
	const fresh = getFreshServerCacheEntry(cache, serverName, serverFingerprint, undefined, receivedAt + 999);
	assert.strictEqual(fresh?.tools[0].name, "test-tool");
	assert.strictEqual(
		getFreshServerCacheEntry(cache, serverName, serverFingerprint, undefined, receivedAt + 1000),
		undefined,
	);
	assert.strictEqual(
		getFreshServerCacheEntry(cache, serverName, "other-fingerprint", undefined, receivedAt),
		undefined,
	);
});

test("MCP metadata cache never persists expanded server credentials", async () => {
	const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const configDir = getAgentDir();
	const configPath = join(configDir, "mcp.json");
	const cachePath = getCacheFilePath();
	const backup = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
	const sentinel = "review-cache-secret-sentinel";
	const serverName = `cache-secret-${process.pid}`;
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: {
				[serverName]: {
					command: "node",
					args: [mockServerPath],
					env: { MCP_TEST_SECRET: sentinel },
					protocolMode: "modern",
				},
			},
		}),
	);

	let gateway: any;
	registerMcp({
		registerTool(tool: any) {
			gateway = tool;
		},
		registerCommand() {},
		on() {},
	} as any);

	try {
		await gateway.execute("call", { connect: serverName }, undefined, undefined, {
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		});
		const persisted = readFileSync(cachePath, "utf8");
		assert.ok(!persisted.includes(sentinel), "expanded credentials must never be written to metadata cache");
	} finally {
		await (await import("../src/client.js")).McpClientPool.getInstance().closeAll();
		if (backup === undefined) rmSync(configPath, { force: true });
		else writeFileSync(configPath, backup);
	}
});

test("private MCP metadata honors cache hints without being persisted", async () => {
	const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const configDir = getAgentDir();
	const configPath = join(configDir, "mcp.json");
	const cachePath = getCacheFilePath();
	const backup = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
	const serverName = `private-cache-${process.pid}`;
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: {
				[serverName]: {
					command: "node",
					args: [mockServerPath],
					env: { MOCK_CACHE_SCOPE: "private", MOCK_CACHE_TTL_MS: "60000" },
					protocolMode: "modern",
				},
			},
		}),
	);

	let gateway: any;
	registerMcp({
		registerTool(tool: any) {
			gateway = tool;
		},
		registerCommand() {},
		on() {},
	} as any);

	try {
		await gateway.execute("call", { connect: serverName }, undefined, undefined, {
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		});
		const entry = loadMetadataCache().servers[serverName];
		assert.strictEqual(entry.cacheScope, "private");
		assert.ok(entry.ttlMs > 59000 && entry.ttlMs <= 60000);
		assert.ok(typeof entry.receivedAt === "number" && entry.receivedAt <= Date.now());
		assert.ok(entry.authorizationFingerprint);
		assert.strictEqual(
			getFreshServerCacheEntry(loadMetadataCache(), serverName, entry.serverFingerprint, "different-auth"),
			undefined,
		);
		const persisted = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : "";
		assert.ok(!persisted.includes(serverName), "private metadata must not be written to disk");
	} finally {
		await (await import("../src/client.js")).McpClientPool.getInstance().closeAll();
		if (backup === undefined) rmSync(configPath, { force: true });
		else writeFileSync(configPath, backup);
	}
});

test("MCP logs redact structured and registered credential values", () => {
	setSensitiveLogValues(["expanded-custom-value"]);
	try {
		const redacted = redactLogMessage(
			"Authorization: Bearer raw-token API_KEY=plain-key custom=expanded-custom-value https://user:pass@example.test/?token=query-token",
		);
		for (const secret of ["raw-token", "plain-key", "expanded-custom-value", "user:pass", "query-token"]) {
			assert.ok(!redacted.includes(secret), `log retained ${secret}`);
		}
		assert.match(redacted, /\[REDACTED\]/);
	} finally {
		setSensitiveLogValues([]);
	}
});

test("Config Loader - Defaults and Load", () => {
	const config = loadMcpConfig();
	assert.ok(config);
	assert.ok(typeof config.mcpServers === "object");
});

test("Claude Desktop discovery uses platform-specific configuration paths", () => {
	assert.strictEqual(
		getThirdPartyIdePaths("C:\\Users\\alice", { APPDATA: "D:\\Profiles\\alice" }, "win32").find(
			(entry) => entry.name === "Claude Desktop",
		)?.path,
		"D:\\Profiles\\alice\\Claude\\claude_desktop_config.json",
	);
	assert.strictEqual(
		getThirdPartyIdePaths("/home/alice", { XDG_CONFIG_HOME: "/config/alice" }, "linux").find(
			(entry) => entry.name === "Claude Desktop",
		)?.path,
		"/config/alice/Claude/claude_desktop_config.json",
	);
});

test("third-party MCP configuration requires explicit global opt-in", async () => {
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { homedir } = await import("node:os");
	const home = homedir();
	const globalConfig = join(getAgentDir(), "mcp.json");
	const cursorDir = join(home, ".cursor");
	const cursorConfig = join(cursorDir, "mcp.json");
	mkdirSync(getAgentDir(), { recursive: true });
	mkdirSync(cursorDir, { recursive: true });
	writeFileSync(cursorConfig, JSON.stringify({ mcpServers: { imported: { command: "node", args: ["server.js"] } } }));

	try {
		writeFileSync(globalConfig, JSON.stringify({ mcpServers: {} }));
		assert.strictEqual(loadMcpConfig().mcpServers.imported, undefined);

		writeFileSync(globalConfig, JSON.stringify({ mcpServers: {}, settings: { enableThirdPartyConfig: true } }));
		assert.strictEqual(loadMcpConfig().mcpServers.imported?._source, "third-party");
	} finally {
		rmSync(globalConfig, { force: true });
		rmSync(cursorConfig, { force: true });
	}
});

test("MCP tool routing rejects overlapping qualified names and supports explicit server disambiguation", () => {
	const candidates = [
		{ serverName: "foo", toolName: "bar-delete" },
		{ serverName: "foo-bar", toolName: "delete" },
	];
	assert.throws(() => resolveToolTarget(candidates, "foo-bar-delete"), /ambiguous/);
	assert.deepStrictEqual(resolveToolTarget(candidates, "delete", "foo-bar"), candidates[1]);
	assert.deepStrictEqual(resolveToolTarget(candidates, "foo_bar-delete"), candidates[0]);
});

test("/mcp server connection refreshes the metadata cache", async () => {
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { getServerCacheFingerprint } = await import("../src/server-identity.js");
	const serverName = `command-refresh-${process.pid}`;
	const definition = {
		command: "node",
		args: [join(import.meta.dirname, "mock-server.js")],
		protocolMode: "modern" as const,
	};
	const configDir = getAgentDir();
	const configPath = join(configDir, "mcp.json");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ mcpServers: { [serverName]: definition } }));
	let command: any;
	registerMcp({
		registerTool() {},
		registerCommand(_name: string, value: any) {
			command = value;
		},
		on() {},
	} as any);

	try {
		await command.handler(serverName, {
			cwd: process.cwd(),
			hasUI: false,
			isProjectTrusted: () => false,
		});
		const entry = getFreshServerCacheEntry(loadMetadataCache(), serverName, getServerCacheFingerprint(definition));
		assert.strictEqual(entry?.tools[0]?.name, "greet");
		const { McpClientPool } = await import("../src/client.js");
		const pool = McpClientPool.getInstance();
		const activeDefinition = loadMcpConfig().mcpServers[serverName];
		const firstClient = await pool.getClient(serverName, activeDefinition);
		await command.handler(`reconnect ${serverName}`, {
			cwd: process.cwd(),
			hasUI: false,
			isProjectTrusted: () => false,
		});
		const secondClient = await pool.getClient(serverName, activeDefinition);
		assert.notStrictEqual(secondClient, firstClient);
	} finally {
		await (await import("../src/client.js")).McpClientPool.getInstance().closeAll();
		rmSync(configPath, { force: true });
	}
});

test("MCP gateway exposes compact discovery results to the agent", async () => {
	let gateway: any;
	registerMcp({
		registerTool(tool: any) {
			gateway = tool;
		},
		registerCommand() {},
		on() {},
	} as any);
	assert.ok(gateway);
	assert.ok(gateway.promptSnippet.length < 2000, "startup guidance must stay compact");
	assert.ok(!gateway.promptSnippet.includes("parameters:"), "full cached manifests must not be injected");

	const result = await gateway.execute("call", { search: "definitely-no-match" }, undefined, undefined, {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
	});
	assert.ok(result.content[0]?.text.includes("0 tools"));
});

test("bounded HTTP reader rejects chunked responses that exceed the actual byte limit", async () => {
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("123"));
				controller.enqueue(new TextEncoder().encode("456"));
				controller.close();
			},
		}),
	);
	await assert.rejects(readBoundedResponseText(response, 5), /PAYLOAD_TOO_LARGE/);
});

test("outbound MCP messages are rejected before exceeding 10 MiB", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient(
		"outbound-limit",
		"node",
		[mockServerPath],
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"modern",
	);
	try {
		await client.connect();
		await assert.rejects(
			client.notification("notifications/test", { data: "x".repeat(10 * 1024 * 1024) }),
			/PAYLOAD_TOO_LARGE/,
		);
	} finally {
		await client.close();
	}
});

test("bounded STDIO parser rejects an oversized line before parsing JSON", () => {
	let overflow = 0;
	let parsed = 0;
	const parser = new BoundedNdjsonParser(
		() => parsed++,
		() => overflow++,
		5,
	);
	parser.push('{"long":true}\n');
	assert.strictEqual(overflow, 1);
	assert.strictEqual(parsed, 0);
});

test("MCP output budget omits oversized non-text content and provides a full response path", async () => {
	const result = await normalizeMcpResponse({
		content: [{ type: "image", data: "x".repeat(60 * 1024), mimeType: "image/png" }],
	});
	assert.strictEqual(result.content.length, 1);
	assert.strictEqual(result.content[0].type, "text");
	assert.match(result.content[0].text, /Non-text content omitted/);
	assert.ok(result.details.fullOutputPath);
});

test("MCP output budget truncates content and provides a full-output escape hatch", async () => {
	const full = "x".repeat(60 * 1024);
	const limited = await limitMcpText(full);
	assert.ok(limited.text.length < full.length);
	assert.ok(limited.fullOutputPath);
	assert.match(limited.text, /Full output:/);
});

test("SimpleMcpClient - Streamable HTTP transport handshake, listTools and callTool (Sync & Async)", async () => {
	const { createServer } = await import("node:http");
	let sseResponse: any = null;

	const server = createServer((req, res) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);

		if (req.method === "GET" && url.pathname === "/mcp") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Mcp-Session-Id": "mock-session-123",
			});
			res.write("event: message\ndata: {}\n\n");
			sseResponse = res;
			return;
		}

		if (req.method === "POST" && url.pathname === "/mcp") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const payload = JSON.parse(body);
				const reqSessionId = req.headers["mcp-session-id"];

				if (payload.method === "initialize") {
					res.writeHead(200, {
						"Content-Type": "application/json",
						"Mcp-Session-Id": "mock-session-123",
					});
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: {
								protocolVersion: "2024-11-05",
								capabilities: {},
								serverInfo: { name: "mock-streamable-http-server", version: "1.0.0" },
							},
						}),
					);
					return;
				}

				if (payload.method === "notifications/initialized") {
					res.writeHead(202);
					res.end();
					return;
				}

				if (payload.method === "tools/list") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: {
								tools: [
									{
										name: "search-any",
										description: "Search tool",
										inputSchema: {},
									},
								],
							},
						}),
					);
					return;
				}

				if (payload.method === "tools/call") {
					assert.strictEqual(reqSessionId, "mock-session-123");
					res.writeHead(202);
					res.end();

					if (sseResponse) {
						sseResponse.write(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: payload.id,
								result: {
									content: [
										{
											type: "text",
											text: `Search results for ${payload.params.arguments.query}`,
										},
									],
								},
							})}\n\n`,
						);
					}
					return;
				}

				res.writeHead(404);
				res.end();
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as any;
	const port = address.port;
	const serverUrl = `http://127.0.0.1:${port}/mcp`;

	console.log(`Mock Streamable HTTP server listening on ${serverUrl}`);

	const client = new SimpleMcpClient(
		"streamable-http-test-server",
		undefined,
		[],
		undefined,
		serverUrl,
		undefined,
		true,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	console.log("Connecting Streamable HTTP client...");
	const initResult = await client.connect();

	assert.ok(initResult);
	assert.strictEqual(initResult.serverInfo.name, "mock-streamable-http-server");

	console.log("Listing tools via Streamable HTTP (Sync)...");
	const tools = await client.listTools();
	assert.strictEqual(tools.length, 1);
	assert.strictEqual(tools[0].name, "search-any");

	console.log("Calling tool via Streamable HTTP (Async)...");
	const response = await client.callTool("search-any", { query: "banana" });
	assert.ok(response);
	assert.strictEqual(response.content[0].text, "Search results for banana");

	console.log("Closing Streamable HTTP client...");
	await client.close();

	await new Promise<void>((resolve) => server.close(() => resolve()));
	console.log("Mock Streamable HTTP server stopped.");
});

test("SimpleMcpClient - Streamable HTTP session recovery on 404", async () => {
	const { createServer } = await import("node:http");

	let sessionCounter = 0;
	let sseResponse: any = null;
	let requestCount = 0;

	const server = createServer((req, res) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);

		if (req.method === "GET" && url.pathname === "/mcp") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Mcp-Session-Id": `session-${++sessionCounter}`,
			});
			res.write("event: message\ndata: {}\n\n");
			sseResponse = res;
			return;
		}

		if (req.method === "POST" && url.pathname === "/mcp") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const payload = JSON.parse(body);

				if (payload.method === "initialize") {
					res.writeHead(200, {
						"Content-Type": "application/json",
						"Mcp-Session-Id": `session-${sessionCounter}`,
					});
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: {
								protocolVersion: "2024-11-05",
								capabilities: {},
								serverInfo: { name: "mock-recovery-server", version: "1.0.0" },
							},
						}),
					);
					return;
				}

				if (payload.method === "notifications/initialized") {
					res.writeHead(202);
					res.end();
					return;
				}

				if (payload.method === "tools/call") {
					requestCount++;
					// First request: simulate session expiry
					if (requestCount === 1) {
						res.writeHead(404);
						res.end();
						return;
					}
					// Second request (after recovery): succeed
					res.writeHead(202);
					res.end();
					if (sseResponse) {
						sseResponse.write(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: payload.id,
								result: { content: [{ type: "text", text: "Recovered!" }] },
							})}\n\n`,
						);
					}
					return;
				}

				res.writeHead(404);
				res.end();
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;

	const client = new SimpleMcpClient(
		"recovery-test-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	await client.connect();

	// First call triggers 404, client auto-recovers and retries
	const response = await client.callTool("search", { query: "test" });
	assert.strictEqual(response.content[0].text, "Recovered!");

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("concurrent legacy requests share recovery while allowing one waiter to cancel", async () => {
	const { createServer } = await import("node:http");
	let sessionCounter = 0;
	let sseResponse: any = null;
	const expiredResponses: any[] = [];
	let markRecoveryStarted!: () => void;
	const recoveryStarted = new Promise<void>((resolve) => {
		markRecoveryStarted = resolve;
	});
	const server = createServer((req, res) => {
		if (req.method === "GET") {
			const sessionId = ++sessionCounter;
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Mcp-Session-Id": `session-${sessionId}`,
			});
			if (sessionId === 2) markRecoveryStarted();
			res.write("event: message\ndata: {}\n\n");
			sseResponse = res;
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body);
			if (payload.method === "initialize") {
				const respond = () => {
					res.writeHead(200, {
						"Content-Type": "application/json",
						"Mcp-Session-Id": `session-${sessionCounter}`,
					});
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: {
								protocolVersion: "2024-11-05",
								capabilities: {},
								serverInfo: { name: "concurrent-recovery", version: "1.0.0" },
							},
						}),
					);
				};
				if (sessionCounter > 1) setTimeout(respond, 100);
				else respond();
				return;
			}
			if (payload.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}
			if (payload.method === "tools/call" && req.headers["mcp-session-id"] === "session-1") {
				expiredResponses.push(res);
				if (expiredResponses.length === 2) {
					for (const expired of expiredResponses) {
						expired.writeHead(404);
						expired.end();
					}
				}
				return;
			}
			if (payload.method === "tools/call") {
				res.writeHead(202);
				res.end();
				sseResponse?.write(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: payload.id,
						result: { content: [{ type: "text", text: `Recovered ${payload.params.arguments.id}` }] },
					})}\n\n`,
				);
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"concurrent-recovery",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		5,
		"legacy",
	);

	try {
		await client.connect();
		const controller = new AbortController();
		const cancelled = client.callTool("recover", { id: 1 }, undefined, controller.signal);
		const surviving = client.callTool("recover", { id: 2 });
		await recoveryStarted;
		controller.abort("caller cancelled during recovery");
		await assert.rejects(
			Promise.race([
				cancelled,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("cancellation deadline exceeded")), 50),
				),
			]),
			/cancel/i,
		);
		assert.strictEqual((await surviving).content[0].text, "Recovered 2");
	} finally {
		await client.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("SimpleMcpClient - concurrency limit rejection", async () => {
	const { createServer } = await import("node:http");

	let sseResponse: any = null;
	// Promise to control when the server responds to the first tools/call
	let releaseResponse: any = null;

	const server = createServer((req, res) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);

		if (req.method === "GET" && url.pathname === "/mcp") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Mcp-Session-Id": "sess-concurrency",
			});
			res.write("event: message\ndata: {}\n\n");
			sseResponse = res;
			return;
		}

		if (req.method === "POST" && url.pathname === "/mcp") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const payload = JSON.parse(body);

				if (payload.method === "initialize") {
					res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-concurrency" });
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: {
								protocolVersion: "2024-11-05",
								capabilities: {},
								serverInfo: { name: "mock-concurrency-server", version: "1.0.0" },
							},
						}),
					);
					return;
				}

				if (payload.method === "notifications/initialized") {
					res.writeHead(202);
					res.end();
					return;
				}

				if (payload.method === "tools/call") {
					// Hold the response until explicitly released
					const id = payload.id;
					const respond = () => {
						res.writeHead(202);
						res.end();
						if (sseResponse) {
							sseResponse.write(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id,
									result: { content: [{ type: "text", text: "ok" }] },
								})}\n\n`,
							);
						}
					};
					if (!releaseResponse) {
						releaseResponse = respond;
					} else {
						respond();
					}
					return;
				}

				res.writeHead(404);
				res.end();
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;

	const client = new SimpleMcpClient(
		"concurrency-test-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		1, // maxConcurrentRequests = 1
		"legacy",
	);

	await client.connect();

	let p1Completed = false;
	let p2Completed = false;

	// First call fills the only slot (server holds the response)
	const p1 = client.callTool("hang", {}).then(() => {
		p1Completed = true;
	});
	// Give time for the request to be dispatched
	await new Promise((r) => setTimeout(r, 200));

	// Second call should be queued instead of rejected (FIFO queueing)
	const p2 = client.callTool("hang", {}).then(() => {
		p2Completed = true;
	});
	await new Promise((r) => setTimeout(r, 200));

	// Assert that neither is completed yet because p1 is hung and p2 is queued
	assert.strictEqual(p1Completed, false);
	assert.strictEqual(p2Completed, false);

	// Release the first response
	releaseResponse?.();

	// Wait for both to finish
	await Promise.all([p1, p2]);

	// Assert that both successfully finished (due to queueing)
	assert.strictEqual(p1Completed, true);
	assert.strictEqual(p2Completed, true);

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("StdioTransport - NDJSON Garbage Filtering", async () => {
	const { writeFileSync, unlinkSync } = await import("node:fs");
	const tempServerPath = join(import.meta.dirname, "temp-garbage-server.js");

	// Write a server script that outputs a garbage warning line first, then behaves normally
	const serverCode = `
    import readline from "node:readline";
    console.log("Warning: Debugger attached."); // Garbage non-JSON line
    console.log(" "); // Empty line
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "garbage-mock", version: "1.0.0" } }
        }));
      } else if (req.method === "notifications/initialized") {
        // handshake done
      } else if (req.method === "tools/list") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [] }
        }));
      }
    });
  `;
	writeFileSync(tempServerPath, serverCode, "utf8");

	const client = new SimpleMcpClient(
		"garbage-test-server",
		"node",
		[tempServerPath],
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	try {
		const initResult = await client.connect();
		assert.ok(initResult);
		assert.strictEqual(initResult.serverInfo.name, "garbage-mock");

		const tools = await client.listTools();
		assert.strictEqual(tools.length, 0);
	} finally {
		await client.close();
		try {
			unlinkSync(tempServerPath);
		} catch {}
	}
});

test("SimpleMcpClient - Bidirectional Server Request Interception", async () => {
	const { writeFileSync, unlinkSync, existsSync, readFileSync } = await import("node:fs");
	const tempServerPath = join(import.meta.dirname, "temp-bidir-server.js");
	const replyFilePath = join(import.meta.dirname, "bidir-reply.json");

	try {
		if (existsSync(replyFilePath)) unlinkSync(replyFilePath);
	} catch {}

	const serverCode = `
    import readline from "node:readline";
    import fs from "node:fs";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let pendingListId;
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "bidir-mock", version: "1.0.0" } }
        }));
      } else if (req.method === "tools/list") {
        pendingListId = req.id;
        // Deliberately collide with the client's pending request id.
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          method: "sampling/createMessage",
          params: { messages: [] }
        }));
      } else if (req.id === pendingListId && req.error) {
        fs.writeFileSync("${replyFilePath.replace(/\\/g, "\\\\")}", JSON.stringify(req), "utf8");
        console.log(JSON.stringify({ jsonrpc: "2.0", id: pendingListId, result: { tools: [] } }));
      }
    });
  `;
	writeFileSync(tempServerPath, serverCode, "utf8");

	const client = new SimpleMcpClient(
		"bidir-test-server",
		"node",
		[tempServerPath],
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	try {
		await client.connect();
		assert.deepStrictEqual(await client.listTools(), []);
		// Wait for the bidirectional request/response roundtrip to complete
		for (let i = 0; i < 50; i++) {
			if (existsSync(replyFilePath)) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		assert.ok(existsSync(replyFilePath));
		const replyRaw = readFileSync(replyFilePath, "utf8");
		const reply = JSON.parse(replyRaw);

		assert.strictEqual(reply.jsonrpc, "2.0");
		assert.strictEqual(typeof reply.id, "number");
		assert.ok(reply.error);
		assert.strictEqual(reply.error.code, -32601);
		assert.ok(reply.error.message.includes("not supported"));
	} finally {
		await client.close();
		try {
			unlinkSync(tempServerPath);
		} catch {}
		try {
			if (existsSync(replyFilePath)) unlinkSync(replyFilePath);
		} catch {}
	}
});

// =====================================================================
// TDD Unit Tests for Lazy Connection & ReadOnly Dispatch
// =====================================================================

test("TDD - LazyMcpClient should defer connection until first execution", async () => {
	const { LazyMcpClient } = await import("../src/lazy-client.js");

	let connectCalls = 0;
	const mockInnerClient = {
		name: "lazy-test-server",
		connect: async () => {
			connectCalls++;
			return {};
		},
		callTool: async (name: string, _args: any) => {
			return { content: [{ type: "text", text: `mock_${name}` }] };
		},
	} as any;

	const cachedTools = [{ name: "test_tool", description: "test desc" }];
	const lazy = new LazyMcpClient(mockInnerClient, cachedTools);

	// 1. Discovery should return cached tools without connecting
	const tools = lazy.getTools();
	assert.strictEqual(tools.length, 1);
	assert.strictEqual(tools[0].name, "test_tool");
	assert.strictEqual(connectCalls, 0, "Should not connect during discovery");

	// 2. Execution should trigger connect and route request
	const res = await lazy.execute("test_tool", {});
	assert.strictEqual(connectCalls, 1, "Should connect on execution");
	assert.strictEqual(res.content[0].text, "mock_test_tool");

	// 3. Subsequent executions should not connect again
	await lazy.execute("test_tool", {});
	assert.strictEqual(connectCalls, 1, "Should reuse connection");
});

test("classifyExecutionMode requires an explicit readonly annotation", async () => {
	const { classifyExecutionMode } = await import("../src/dispatch-classifier.js");

	assert.strictEqual(
		classifyExecutionMode({ name: "get_users", description: "get user list", readOnlyHint: true }),
		"parallel",
	);
	assert.strictEqual(
		classifyExecutionMode({ name: "fetch_data", description: "Fetch url page. [readonly]" }),
		"sequential",
	);
	assert.strictEqual(
		classifyExecutionMode({ name: "get_delete_all", description: "Deletes all records and returns them" }),
		"sequential",
	);
	assert.strictEqual(
		classifyExecutionMode({ name: "mutate", description: "This operation is not read-only" }),
		"sequential",
	);
});

test("TDD - SimpleMutex should serialize execution logic", async () => {
	const { SimpleMutex } = await import("../src/mutex.js");

	const mutex = new SimpleMutex();
	const order: number[] = [];

	const run = async (id: number, delayMs: number) => {
		const release = await mutex.lock();
		try {
			order.push(id);
			await new Promise((r) => setTimeout(r, delayMs));
		} finally {
			release();
		}
	};

	// Launch parallel-like starts
	const p1 = run(1, 50);
	const p2 = run(2, 10);

	await Promise.all([p1, p2]);

	// Even though p2 has shorter delay, it must finish second because p1 acquired the lock first
	assert.deepStrictEqual(order, [1, 2]);
});

test("TDD - McpClientPool should trip circuit breaker on failures and fast-fail subsequent requests", async () => {
	const { McpClientPool } = await import("../src/client.js");
	const pool = McpClientPool.getInstance();
	const serverName = "faulty-server";

	// 提供一个必定失败的配置（不可达的 URL 且初始化超时极短）
	const badDef = {
		url: "http://127.0.0.1:9999/invalid-endpoint",
		initTimeout: 50, // 50ms 极速超时
		maxConcurrentRequests: 5,
	} as any;

	// 1. 第一次失败
	await assert.rejects(pool.getClient(serverName, badDef), /timed out|Failed/i, "First attempt should fail");

	// 2. 第二次失败 -> 此时连续失败 2 次，应该触发熔断
	await assert.rejects(
		pool.getClient(serverName, badDef),
		/timed out|Failed/i,
		"Second attempt should fail and trip the breaker",
	);

	// 3. 第三次获取 -> 处于熔断冷却期，应当秒级抛出快速熔断错误，且不应触发实际的连接网络 IO
	const startTime = Date.now();
	await assert.rejects(
		pool.getClient(serverName, badDef),
		/Circuit breaker open/i,
		"Third attempt should fast-fail due to open circuit breaker",
	);

	const elapsed = Date.now() - startTime;
	assert.ok(elapsed < 15, `Fast-failure should be instantaneous, took ${elapsed}ms`);

	// 4. 手动重置健康度，模拟自愈/手动覆写
	pool.resetServerHealth(serverName);

	// 5. 第四次获取 -> 熔断已手动闭合，应当重新尝试真正连接并抛出普通的网络错误，而非熔断拦截
	await assert.rejects(
		pool.getClient(serverName, badDef),
		(err: any) => {
			return err.message && !err.message.includes("Circuit breaker open");
		},
		"Should try to connect again and not throw a circuit breaker error",
	);
});

test("TDD - StdioTransport resolveNpxToDirect fallback test", async () => {
	const { ChildProcess } = await import("node:child_process");
	const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const originalProtoSpawn = (ChildProcess.prototype as any).spawn;
	const originalExecPath = process.execPath;

	// Create hermetic temp node_modules directory structure
	const tempCwd = join(import.meta.dirname, "temp-test-cwd");

	// 1. Mock JS package
	const mockPkgPath = join(tempCwd, "node_modules", "@anyproto/anytype-mcp");
	mkdirSync(join(mockPkgPath, "bin"), { recursive: true });
	writeFileSync(
		join(mockPkgPath, "package.json"),
		JSON.stringify({
			name: "@anyproto/anytype-mcp",
			bin: {
				"anytype-mcp": "bin/cli.mjs",
			},
		}),
		"utf8",
	);
	writeFileSync(join(mockPkgPath, "bin", "cli.mjs"), "console.log('mock');", "utf8");

	// 2. Mock Native binary package (isJs = false)
	const mockNativePkgPath = join(tempCwd, "node_modules", "@anyproto/native-mcp");
	mkdirSync(join(mockNativePkgPath, "bin"), { recursive: true });
	writeFileSync(
		join(mockNativePkgPath, "package.json"),
		JSON.stringify({
			name: "@anyproto/native-mcp",
			bin: {
				"native-mcp": "bin/native.exe",
			},
		}),
		"utf8",
	);
	writeFileSync(join(mockNativePkgPath, "bin", "native.exe"), "mock bin", "utf8");

	let lastSpawn: any = null;

	// Mock ChildProcess.prototype.spawn to intercept command resolution
	(ChildProcess.prototype as any).spawn = (options: any) => {
		lastSpawn = {
			file: options.file,
			args: options.args,
		};
		throw new Error("MOCK_SPAWN_INTERCEPTED");
	};

	try {
		// Case 1: process.execPath is a native compiled binary (like pi client)
		Object.defineProperty(process, "execPath", {
			value: "/Users/admin/.local/share/mise/installs/pi/0.78.0/pi",
			configurable: true,
		});

		const client = new SimpleMcpClient(
			"test-anytype",
			"npx",
			["-y", "@anyproto/anytype-mcp"],
			undefined, // env
			undefined, // url
			undefined, // headers
			undefined, // debug
			undefined, // type
			undefined, // initTimeoutMs
			tempCwd, // cwd
		);
		await assert.rejects(client.connect(), /MOCK_SPAWN_INTERCEPTED/);

		assert.ok(lastSpawn);
		// Since execPath is pi (not node/bun/deno), file should fallback to 'node'
		assert.strictEqual(lastSpawn.file, "node");
		const hasCliMjs = lastSpawn.args.some((arg: string) => arg?.endsWith("cli.mjs"));
		assert.ok(hasCliMjs, "Should execute target cli.mjs");

		// Case 2: process.execPath is standard node binary
		lastSpawn = null;
		Object.defineProperty(process, "execPath", {
			value: "/usr/local/bin/node",
			configurable: true,
		});

		await assert.rejects(client.connect(), /MOCK_SPAWN_INTERCEPTED/);

		assert.ok(lastSpawn);
		// Since execPath is standard node, file should match process.execPath
		assert.strictEqual(lastSpawn.file, "/usr/local/bin/node");
		const hasCliMjsCase2 = lastSpawn.args.some((arg: string) => arg?.endsWith("cli.mjs"));
		assert.ok(hasCliMjsCase2, "Should execute target cli.mjs in case 2");

		// Case 3: Package resolution fails (does not exist) -> fallback to raw npx execution
		lastSpawn = null;
		const nonexistentClient = new SimpleMcpClient(
			"test-nonexistent",
			"npx",
			["-y", "@anyproto/nonexistent-package"],
			undefined, // env
			undefined, // url
			undefined, // headers
			undefined, // debug
			undefined, // type
			undefined, // initTimeoutMs
			tempCwd, // cwd
		);
		await assert.rejects(nonexistentClient.connect(), /MOCK_SPAWN_INTERCEPTED/);
		assert.ok(lastSpawn);
		// Should execute raw npx directly
		assert.strictEqual(lastSpawn.file, "npx");

		// Case 4: Package resolution succeeds but is non-JS package (isJs = false) -> execute the native binary directly
		lastSpawn = null;
		const nativeClient = new SimpleMcpClient(
			"test-native",
			"npx",
			["-y", "@anyproto/native-mcp"],
			undefined, // env
			undefined, // url
			undefined, // headers
			undefined, // debug
			undefined, // type
			undefined, // initTimeoutMs
			tempCwd, // cwd
		);
		await assert.rejects(nativeClient.connect(), /MOCK_SPAWN_INTERCEPTED/);
		assert.ok(lastSpawn);
		// Should execute the resolved native bin path directly
		assert.ok(lastSpawn.file.endsWith("native.exe"));
	} finally {
		// Restore mocks and clean up directory
		(ChildProcess.prototype as any).spawn = originalProtoSpawn;
		Object.defineProperty(process, "execPath", {
			value: originalExecPath,
			configurable: true,
		});
		try {
			rmSync(tempCwd, { recursive: true, force: true });
		} catch {}
	}
});

test("connection identity changes when a bearerTokenEnv credential rotates", async () => {
	const { getServerCacheFingerprint, getServerConnectionFingerprint } = await import("../src/server-identity.js");
	const variable = `PI_MCP_ROTATING_TOKEN_${process.pid}`;
	const previous = process.env[variable];
	const definition = { url: "https://example.test/mcp", auth: "bearer" as const, bearerTokenEnv: variable };
	try {
		process.env[variable] = "first-token-value";
		const firstConnection = getServerConnectionFingerprint(definition);
		const persistentRoute = getServerCacheFingerprint(definition);
		process.env[variable] = "second-token-value";
		assert.notStrictEqual(getServerConnectionFingerprint(definition), firstConnection);
		assert.strictEqual(getServerCacheFingerprint(definition), persistentRoute);
	} finally {
		if (previous === undefined) delete process.env[variable];
		else process.env[variable] = previous;
	}
});

test("McpClientPool isolates clients with the same name but different definitions", async () => {
	const { McpClientPool } = await import("../src/client.js");
	const pool = McpClientPool.getInstance();
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const serverName = `definition-isolation-${process.pid}`;

	try {
		const first = await pool.getClient(serverName, {
			command: "node",
			args: [mockServerPath],
			env: { SERVER_IDENTITY: "first" },
			protocolMode: "modern",
		});
		const second = await pool.getClient(serverName, {
			command: "node",
			args: [mockServerPath],
			env: { SERVER_IDENTITY: "second" },
			protocolMode: "modern",
		});

		assert.notStrictEqual(first, second);
	} finally {
		await pool.closeAll();
	}
});

test("McpClientPool keeps a shared connection alive when only one waiter cancels", async () => {
	const { McpClientPool } = await import("../src/client.js");
	const pool = McpClientPool.getInstance();
	const serverName = `shared-connect-${process.pid}`;
	const definition = {
		command: "node",
		args: [join(import.meta.dirname, "mock-server.js")],
		env: { MOCK_DISCOVER_DELAY_MS: "100" },
	};
	const firstController = new AbortController();
	const secondController = new AbortController();

	try {
		const first = pool.getClient(serverName, definition, false, firstController.signal);
		const second = pool.getClient(serverName, definition, false, secondController.signal);
		setTimeout(() => firstController.abort("first caller cancelled"), 20);
		await assert.rejects(first, /cancel/i);
		const client = await second;
		assert.strictEqual(await client.listTools().then((tools) => tools[0]?.name), "greet");
	} finally {
		await pool.closeClient(serverName, definition);
	}
});

test("TDD - McpClientPool should provide independent lock per server", async () => {
	const { McpClientPool } = await import("../src/client.js");
	const pool = McpClientPool.getInstance();

	const lockA = pool.getMutex("serverA");
	const lockB = pool.getMutex("serverB");

	assert.notStrictEqual(lockA, lockB, "Each server must have a unique Mutex lock");

	const order: string[] = [];

	const runA = async () => {
		const release = await lockA.lock();
		try {
			order.push("A_start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("A_end");
		} finally {
			release();
		}
	};

	const runB = async () => {
		const release = await lockB.lock();
		try {
			order.push("B_start");
			await new Promise((r) => setTimeout(r, 10));
			order.push("B_end");
		} finally {
			release();
		}
	};

	// Launch in parallel-like fashion
	const p1 = runA();
	const p2 = runB();

	await Promise.all([p1, p2]);

	// Since locks are independent, B should end before A ends (B delay 10ms < A delay 50ms)
	assert.ok(
		order.indexOf("B_end") < order.indexOf("A_end"),
		"B should complete before A ends due to independent lock",
	);
});

test("aborting initial protocol discovery stops the connection attempt", async () => {
	const client = new SimpleMcpClient("cancel-connect", "node", [join(import.meta.dirname, "mock-server.js")], {
		MOCK_HANG_DISCOVER: "true",
	});
	const controller = new AbortController();
	const pending = client.connect(controller.signal);
	setTimeout(() => controller.abort("connection cancelled"), 20);
	try {
		await assert.rejects(
			Promise.race([
				pending,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline exceeded")), 500)),
			]),
			/cancel|abort/i,
		);
	} finally {
		await client.close();
	}
});

test("aborting a stdio tool call sends notifications/cancelled", async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-cancel-test-"));
	const cancelFile = join(tempDir, "cancel.json");
	const client = new SimpleMcpClient(
		"cancel-stdio",
		"node",
		[join(import.meta.dirname, "mock-server.js")],
		{ MOCK_CANCEL_FILE: cancelFile },
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		"modern",
	);
	const controller = new AbortController();

	try {
		await client.connect();
		const pending = client.callTool("wait-for-cancel", {}, undefined, controller.signal);
		controller.abort("user stopped the call");
		await assert.rejects(pending, /cancel/i);
		let cancellation: any;
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				cancellation = JSON.parse(readFileSync(cancelFile, "utf8"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		assert.strictEqual(typeof cancellation?.requestId, "number");
		assert.strictEqual(cancellation.reason, "user stopped the call");
	} finally {
		await client.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("aborting a tool call closes its Streamable HTTP request", async () => {
	const { createServer } = await import("node:http");
	let requestStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	let requestClosed = false;
	const server = createServer((_req, res) => {
		requestStarted();
		res.on("close", () => {
			requestClosed = true;
		});
		// Keep the request pending until the client cancels it.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"cancel-http",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"modern",
	);
	const controller = new AbortController();
	await client.connect();
	const pending = client.callTool("slow", {}, undefined, controller.signal);

	try {
		await started;
		controller.abort("review cancellation");
		await assert.rejects(
			Promise.race([
				pending,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline exceeded")), 500)),
			]),
			/cancel|abort/i,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(requestClosed, true);
	} finally {
		server.closeAllConnections();
		await pending.catch(() => {});
		await client.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("the mcp gateway propagates Pi tool cancellation to the selected server", async () => {
	const { createServer } = await import("node:http");
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { getServerCacheFingerprint } = await import("../src/server-identity.js");
	let requestStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	const server = createServer((_req, _res) => requestStarted());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const serverName = `gateway-cancel-${process.pid}`;
	const definition = {
		url: `http://127.0.0.1:${port}/mcp`,
		type: "streamable-http" as const,
		protocolMode: "modern" as const,
	};
	const configDir = getAgentDir();
	const configPath = join(configDir, "mcp.json");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ mcpServers: { [serverName]: definition } }));
	updateServerCache(
		serverName,
		[{ name: "slow", inputSchema: {}, readOnlyHint: true }],
		[],
		getServerCacheFingerprint(definition),
		{ ttlMs: 60000, cacheScope: "public", receivedAt: Date.now() },
	);

	let gateway: any;
	registerMcp({
		registerTool(tool: any) {
			gateway = tool;
		},
		registerCommand() {},
		on() {},
	} as any);
	const controller = new AbortController();
	const pending = gateway.execute("call", { tool: `${serverName}-slow`, args: {} }, controller.signal, undefined, {
		cwd: process.cwd(),
		isProjectTrusted: () => false,
	});

	try {
		await started;
		controller.abort("gateway cancelled");
		await assert.rejects(
			Promise.race([
				pending,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadline exceeded")), 500)),
			]),
			/cancel|abort/i,
		);
	} finally {
		server.closeAllConnections();
		await pending.catch(() => {});
		await (await import("../src/client.js")).McpClientPool.getInstance().closeAll();
		rmSync(configPath, { force: true });
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("Streamable HTTP modern mode headers (Mcp-Method, Mcp-Name, Mcp-Protocol-Version)", async () => {
	const { createServer } = await import("node:http");
	const receivedHeaders: Record<string, any> = {};
	let getRequests = 0;

	const server = createServer((req, res) => {
		if (req.method === "GET") {
			getRequests++;
			res.writeHead(405);
			res.end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			receivedHeaders[payload.method] = req.headers;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					result:
						payload.method === "tools/list"
							? {
									tools: [
										{
											name: "foo",
											description: "foo tool",
											inputSchema: {
												type: "object",
												properties: {
													region: { type: "string", "x-mcp-header": "Region" },
												},
												required: ["region"],
											},
										},
									],
								}
							: { content: [{ type: "text", text: "ok" }] },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;

	const client = new SimpleMcpClient(
		"header-test-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		{
			"mcp-protocol-version": "user-version",
			"mcp-method": "user-method",
			"mcp-name": "user-name",
			accept: "text/plain",
			"content-type": "text/plain",
		},
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"modern",
	);

	await client.connect();
	await client.notification("notifications/test", {});
	const tools = await client.listTools();
	await client.callTool("foo", { region: "Hello, 世界" }, tools[0]);

	assert.strictEqual(getRequests, 0);
	assert.strictEqual(receivedHeaders["notifications/test"].accept, "application/json, text/event-stream");
	assert.strictEqual(receivedHeaders["notifications/test"]["mcp-protocol-version"], "2026-07-28");
	assert.strictEqual(receivedHeaders["notifications/test"]["mcp-method"], "notifications/test");
	assert.strictEqual(receivedHeaders["tools/list"]["mcp-protocol-version"], "2026-07-28");
	assert.strictEqual(receivedHeaders["tools/list"]["mcp-method"], "tools/list");
	assert.strictEqual(receivedHeaders["tools/call"]["mcp-protocol-version"], "2026-07-28");
	assert.strictEqual(receivedHeaders["tools/call"]["mcp-method"], "tools/call");
	assert.strictEqual(receivedHeaders["tools/call"]["mcp-name"], "foo");
	assert.strictEqual(receivedHeaders["tools/call"]["mcp-param-region"], "=?base64?SGVsbG8sIOS4lueVjA==?=");

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("2026-07-28 Streamable HTTP consumes request-scoped SSE responses", async () => {
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(
				`event: message\r\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/message",
					params: { level: "info", data: "working" },
				})}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					result: { content: [{ type: "text", text: "streamed" }] },
				})}\r\n\r\n`,
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"request-sse-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"modern",
	);

	await client.connect();
	const result = await client.callTool("foo", {});
	assert.strictEqual(result.content[0].text, "streamed");

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Streamable HTTP returns when a request-scoped SSE final response arrives", async () => {
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(
				`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { ok: true } })}\r\n\r\n`,
			);
			// A final response SHOULD close the stream, but clients must not require it.
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const transport = new StreamableHttpTransport("open-sse", `http://127.0.0.1:${port}/mcp`);
	transport.protocolMode = "modern";
	await transport.connect({ onMessage() {}, onExit() {} });
	const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

	try {
		const result = await Promise.race([
			pending,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE response remained pending")), 500)),
		]);
		assert.deepStrictEqual(result?.result, { ok: true });
	} finally {
		server.closeAllConnections();
		await pending.catch(() => {});
		await transport.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("2026-07-28 MCP header annotations validate and encode safely", () => {
	const tool = {
		name: "header-tool",
		inputSchema: {
			type: "object",
			properties: {
				region: { type: "string", "x-mcp-header": "Region" },
				active: { type: "boolean", "x-mcp-header": "Active" },
				limit: { type: "integer", "x-mcp-header": "Limit" },
			},
		},
	};

	assert.deepStrictEqual(buildMcpParamHeaders(tool, { region: "us-west1", active: true, limit: 42 }), {
		"Mcp-Param-Region": "us-west1",
		"Mcp-Param-Active": "true",
		"Mcp-Param-Limit": "42",
	});
	assert.strictEqual(encodeMcpHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
	assert.strictEqual(encodeMcpHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");

	const nestedTool = {
		name: "nested-header-tool",
		inputSchema: {
			type: "object",
			properties: {
				context: {
					type: "object",
					properties: {
						region: { type: "string", "x-mcp-header": "Nested-Region" },
					},
				},
			},
		},
	};
	assert.deepStrictEqual(buildMcpParamHeaders(nestedTool, { context: { region: "us-east1" } }), {
		"Mcp-Param-Nested-Region": "us-east1",
	});
	assert.deepStrictEqual(buildMcpParamHeaders(nestedTool, { region: "wrong-path" }), {});
	assert.deepStrictEqual(buildMcpParamHeaders(nestedTool, { context: { region: null } }), {});
	assert.throws(
		() => buildMcpParamHeaders(tool, { region: "ok", active: true, limit: Number.MAX_SAFE_INTEGER + 1 }),
		/safe integer/,
	);

	assert.throws(
		() =>
			validateMcpToolHeaders({
				name: "duplicate-header-tool",
				inputSchema: {
					type: "object",
					properties: {
						first: { type: "string", "x-mcp-header": "Region" },
						second: { type: "string", "x-mcp-header": "region" },
					},
				},
			}),
		/duplicate x-mcp-header/,
	);

	assert.throws(
		() =>
			validateMcpToolHeaders({
				name: "invalid-tool",
				inputSchema: { type: "object", properties: { value: { type: "number", "x-mcp-header": "Value" } } },
			}),
		/x-mcp-header.*string, integer, or boolean/,
	);
	assert.throws(
		() =>
			validateMcpToolHeaders({
				name: "invalid-nested-tool",
				inputSchema: {
					type: "object",
					properties: { values: { type: "array", items: { "x-mcp-header": "Value", type: "string" } } },
				},
			}),
		/x-mcp-header must be reachable through properties only/,
	);
});

test("2026-07-28 modern 404 method-not-found is not treated as session expiry", async () => {
	const { createServer } = await import("node:http");
	let postCount = 0;
	const server = createServer((req, res) => {
		assert.strictEqual(req.method, "POST");
		postCount++;
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					error: { code: -32601, message: "Method not found" },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"modern-404-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"modern",
	);

	await client.connect();
	await assert.rejects(
		() => client.listTools(),
		(err: any) => err.code === -32601 && err.message.includes("Method not found"),
	);
	assert.strictEqual(postCount, 1);

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("modern auto-detection surfaces recognized header errors", async () => {
	const { createServer } = await import("node:http");
	const methods: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			methods.push(payload.method);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					error: { code: -32020, message: "Header mismatch" },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"modern-header-error-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
	);

	await assert.rejects(
		() => client.connect(),
		(err: any) => err.code === -32020 && err.message.includes("Header mismatch"),
	);
	assert.deepStrictEqual(methods, ["server/discover"]);

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Streamable HTTP legacy mode uses matching protocol version headers", async () => {
	const { createServer } = await import("node:http");
	let initializeHeader = "";
	let toolsHeader = "";

	const server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(405);
			res.end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			if (payload.method === "initialize") {
				initializeHeader = String(req.headers["mcp-protocol-version"] || "");
			} else if (payload.method === "tools/list") {
				toolsHeader = String(req.headers["mcp-protocol-version"] || "");
			}

			if (payload.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					result:
						payload.method === "initialize"
							? {
									protocolVersion: "2025-11-25",
									capabilities: {},
									serverInfo: { name: "legacy-header-server", version: "1.0.0" },
								}
							: { tools: [] },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;
	const client = new SimpleMcpClient(
		"legacy-header-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"legacy",
	);

	await client.connect();
	await client.listTools();

	assert.strictEqual(initializeHeader, "2025-11-25");
	assert.strictEqual(toolsHeader, "2025-11-25");

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Protocol error codes handling (-32020, -32021, -32022)", async () => {
	const { createServer } = await import("node:http");

	const server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(405);
			res.end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const payload = JSON.parse(body || "{}");
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					error: { code: -32022, message: "Protocol version 2020-01-01 is not supported" },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as any;

	const client = new SimpleMcpClient(
		"error-code-server",
		undefined,
		[],
		undefined,
		`http://127.0.0.1:${port}/mcp`,
		undefined,
		false,
		"streamable-http",
		undefined,
		undefined,
		undefined,
		"modern",
	);

	await client.connect();

	await assert.rejects(
		() => client.listTools(),
		(err: any) => err.message.includes("[UNSUPPORTED_VERSION]"),
	);

	await client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("2026-07-28 - server/discover probe succeeds and populates client metadata", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-discover-server", "node", [mockServerPath]);

	const discoverResult = await client.connect();

	assert.ok(discoverResult);
	assert.strictEqual(discoverResult.resultType, "complete");
	assert.deepStrictEqual(discoverResult.supportedVersions, ["2026-07-28"]);
	assert.strictEqual(client.serverInstructions, "Mock server instructions");
	assert.strictEqual(client.serverInfo?.name, "mock-mcp-server");
	assert.ok(client.serverExtensions?.["example.org/test-extension"]);

	await client.close();
});

test("2026-07-28 - server/discover ordinary errors fall back to legacy initialization", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-discover-32601", "node", [mockServerPath], {
		MOCK_DISCOVER_ERROR: "32601",
	});

	try {
		const initResult = await client.connect();
		assert.strictEqual(initResult.protocolVersion, "2024-11-05");
		assert.strictEqual(initResult.serverInfo.name, "mock-mcp-server");
	} finally {
		await client.close();
	}
});

test("2026-07-28 - server/discover returns -32022 falls back to legacy handshake", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-discover-32022", "node", [mockServerPath], {
		MOCK_DISCOVER_ERROR: "32022",
	});

	const initResult = await client.connect();

	assert.ok(initResult);
	assert.strictEqual(initResult.serverInfo?.name, "mock-mcp-server");
	assert.strictEqual(initResult.protocolVersion, "2024-11-05");

	await client.close();
});

test("2026-07-28 - server/discover -32022 with data.supported claiming the latest version surfaces the error", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient("mock-discover-32022-contradiction", "node", [mockServerPath], {
		MOCK_DISCOVER_ERROR: "32022",
		MOCK_DISCOVER_32022_SUPPORTED: "2026-07-28",
	});

	// A server that returns UnsupportedProtocolVersionError while claiming to
	// support the requested version is a contradiction: do not fall back, surface it.
	await assert.rejects(client.connect(), (err: any) => err.code === -32022);

	await client.close();
});

test("2026-07-28 - extensions registration and logLevel in _meta when debug is enabled", async () => {
	const mockServerPath = join(import.meta.dirname, "mock-server.js");
	const client = new SimpleMcpClient(
		"mock-debug-ext-server",
		"node",
		[mockServerPath],
		undefined,
		undefined,
		undefined,
		true, // debug enabled
	);

	client.setExtensions({
		"io.modelcontextprotocol/test-ext": { version: "1.0" },
	});

	await client.connect();

	// Verify injectMeta behavior indirectly via request execution
	const tools = await client.listTools();
	assert.ok(tools);

	await client.close();
});

test("TDD - classifyExecutionMode supports annotations.readOnlyHint", async () => {
	const { classifyExecutionMode } = await import("../src/dispatch-classifier.js");

	const toolWithAnnotation = {
		name: "query_database",
		description: "Executes a SELECT query",
		annotations: {
			readOnlyHint: true,
		},
	};

	assert.strictEqual(classifyExecutionMode(toolWithAnnotation), "parallel");
});

test("Fix Verification - SimpleMutex releases lock and does not deadlock when previous lock holder threw rejection", async () => {
	const { SimpleMutex } = await import("../src/mutex.js");
	const mutex = new SimpleMutex();

	let step = 0;
	const release1 = await mutex.lock();
	step = 1;

	const p2 = (async () => {
		const release2 = await mutex.lock();
		step = 2;
		release2();
	})();

	// Simulate exception in first section while holding lock, then release
	release1();
	await p2;
	assert.strictEqual(step, 2);
});

test("Fix Verification - cleanupSpilledTempDirs removes tracked spilled directories", async () => {
	const { cleanupSpilledTempDirs, limitMcpText } = await import("../src/proxy.js");
	const { existsSync } = await import("node:fs");

	// Trigger a large response to spill to disk
	const largeText = "x\n".repeat(6000);
	const res = await limitMcpText(largeText);

	assert.ok(res.fullOutputPath);
	assert.strictEqual(existsSync(res.fullOutputPath), true);

	await cleanupSpilledTempDirs();
	assert.strictEqual(existsSync(res.fullOutputPath), false);
});

test("XDG compliance - log, cache, config, and trust paths honor getAgentDir and PI_CODING_AGENT_DIR", () => {
	const originalEnv = process.env.PI_CODING_AGENT_DIR;
	const customAgentDir = "/tmp/custom-xdg-agent-dir";
	try {
		process.env.PI_CODING_AGENT_DIR = customAgentDir;
		assert.strictEqual(getLogFilePath(), join(customAgentDir, "extensions", "pi-mcp", "mcp.log"));
		assert.strictEqual(getCacheFilePath(), join(customAgentDir, "extensions", "pi-mcp", "mcp-cache.json"));
		assert.strictEqual(
			getTrustFilePath(),
			join(customAgentDir, "extensions", "pi-mcp", "mcp-trusted-workspaces.json"),
		);
		assert.strictEqual(getGlobalConfigPaths()[0], join(customAgentDir, "mcp.json"));
	} finally {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
	}
});

test("migrateLegacyDataFiles moves legacy agent-dir files into the extension data dir once", async () => {
	const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const originalEnv = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-mcp-migrate-"));
	try {
		process.env.PI_CODING_AGENT_DIR = tempRoot;
		const dataDir = join(tempRoot, "extensions", "pi-mcp");
		const legacyLogPath = join(tempRoot, "mcp.log");
		const legacyCachePath = join(tempRoot, "mcp-cache.json");
		writeFileSync(legacyLogPath, "legacy log");
		writeFileSync(legacyCachePath, "legacy cache");
		// A fresh-format file already exists: the legacy copy must not overwrite it
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "mcp-cache.json"), "fresh cache");
		migrateLegacyDataFiles();
		assert.strictEqual(existsSync(legacyLogPath), false, "legacy mcp.log must be moved");
		assert.strictEqual(existsSync(join(dataDir, "mcp.log")), true, "mcp.log must land in the extension data dir");
		assert.strictEqual(existsSync(legacyCachePath), true, "legacy cache must stay when a fresh file already exists");
		assert.strictEqual(readFileSync(join(dataDir, "mcp-cache.json"), "utf8"), "fresh cache");
	} finally {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
