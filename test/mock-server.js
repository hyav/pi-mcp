import { writeFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

rl.on("line", async (line) => {
	try {
		const request = JSON.parse(line);
		const { id, method, params } = request;

		if (method === "notifications/cancelled") {
			if (process.env.MOCK_CANCEL_FILE) {
				writeFileSync(process.env.MOCK_CANCEL_FILE, JSON.stringify(params), "utf8");
			}
			return;
		}

		if (process.env.MOCK_HANG_DISCOVER === "true" && method === "server/discover") return;
		if (process.env.MOCK_DISCOVER_DELAY_MS && method === "server/discover") {
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_DISCOVER_DELAY_MS)));
		}

		if (process.env.MOCK_DISCOVER_ERROR === "32601" && method === "server/discover") {
			const response = {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "Method not found" },
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
			return;
		}

		if (process.env.MOCK_DISCOVER_ERROR === "32022" && method === "server/discover") {
			const response = {
				jsonrpc: "2.0",
				id,
				error: { code: -32022, message: "Unsupported version" },
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
			return;
		}

		if (method === "server/discover") {
			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
					capabilities: {
						tools: {},
						resources: {},
						extensions: {
							"example.org/test-extension": { enabled: true },
						},
					},
					instructions: "Mock server instructions",
					ttlMs: 3600000,
					cacheScope: "public",
					_meta: {
						"io.modelcontextprotocol/serverInfo": {
							name: "mock-mcp-server",
							version: "1.0.0",
						},
					},
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		} else if (method === "initialize") {
			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: {
						tools: {},
					},
					serverInfo: {
						name: "mock-mcp-server",
						version: "1.0.0",
					},
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		} else if (method === "notifications/initialized") {
			// Handshake complete, nothing to reply
		} else if (method === "tools/list") {
			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					ttlMs: Number(process.env.MOCK_CACHE_TTL_MS || 3600000),
					cacheScope: process.env.MOCK_CACHE_SCOPE || "public",
					tools: [
						{
							name: "greet",
							description: "Greet a user by name",
							inputSchema: {
								type: "object",
								properties: {
									name: { type: "string" },
								},
								required: ["name"],
							},
						},
						{
							name: "interactive",
							description: "Tool requiring MRTR input",
							inputSchema: {
								type: "object",
								properties: {
									confirmation: { type: "string" },
								},
							},
						},
					],
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		} else if (method === "tools/call") {
			const name = params.name;
			const args = params.arguments || {};

			if (name === "wait-for-cancel") return;

			if (name === "interactive" && !params.requestState) {
				const response = {
					jsonrpc: "2.0",
					id,
					result: {
						resultType: "input_required",
						inputRequests: [{ name: "confirmation", description: "Please confirm" }],
						requestState: "mock-state-token-123",
					},
				};
				process.stdout.write(`${JSON.stringify(response)}\n`);
				return;
			}
			if (name === "interactive" && params.requestState) {
				const response = {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: "Confirmed!" }],
					},
				};
				process.stdout.write(`${JSON.stringify(response)}\n`);
				return;
			}

			let resultText = "";

			if (name === "inspect-env") {
				resultText = JSON.stringify({
					hostOnly: process.env.HOST_ONLY_SENTINEL ?? null,
					explicit: process.env.EXPLICIT_SENTINEL ?? null,
				});
			} else if (name === "greet") {
				resultText = `Hello, ${args.name || "World"}!`;
			} else {
				resultText = `Unknown tool ${name}`;
			}

			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: resultText,
						},
					],
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		} else if (method === "resources/list") {
			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					ttlMs: Number(process.env.MOCK_CACHE_TTL_MS || 3600000),
					cacheScope: process.env.MOCK_CACHE_SCOPE || "public",
					resources: [
						{
							uri: "mock://settings",
							name: "Mock System Settings",
							description: "Mock key-value pairs representing configurations",
						},
					],
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		} else if (method === "resources/read") {
			const uri = params.uri;
			const response = {
				jsonrpc: "2.0",
				id,
				result: {
					contents: [
						{
							uri: uri,
							mimeType: "application/json",
							text: JSON.stringify({ theme: "dark", version: "1.0.0" }, null, 2),
						},
					],
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		}
	} catch (err) {
		console.error("Mock Server error:", err);
	}
});
