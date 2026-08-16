import type { SimpleMcpClient } from "./client.js";
import type { McpTool } from "./types.js";

/**
 * LazyMcpClient decorator: wraps SimpleMcpClient to defer execution
 * of the connection handshake until the first tool/resource execution.
 */
export class LazyMcpClient {
	private isConnected = false;
	private connectPromise: Promise<any> | null = null;

	constructor(
		private client: SimpleMcpClient | any,
		private cachedTools: McpTool[] = [],
	) {}

	public getTools(): McpTool[] {
		return this.cachedTools;
	}

	/**
	 * Helper to ensure the connection is active.
	 * Concurrently-called executes share the same connect promise.
	 */
	private async ensureConnected(): Promise<any> {
		if (this.isConnected) {
			return;
		}
		if (this.connectPromise) {
			return this.connectPromise;
		}

		this.connectPromise = (async () => {
			try {
				const res = await this.client.connect();
				this.isConnected = true;
				return res;
			} finally {
				this.connectPromise = null;
			}
		})();

		return this.connectPromise;
	}

	/**
	 * Execute a tool, connecting the client on demand first.
	 */
	public async execute(toolName: string, args: any) {
		await this.ensureConnected();
		return this.client.callTool(toolName, args);
	}

	/**
	 * Transparent proxy methods for other client utilities
	 */

	public async listTools() {
		await this.ensureConnected();
		return this.client.listTools();
	}

	public async listResources() {
		await this.ensureConnected();
		return this.client.listResources();
	}

	public async readResource(uri: string) {
		await this.ensureConnected();
		return this.client.readResource(uri);
	}

	public async listPrompts() {
		await this.ensureConnected();
		return this.client.listPrompts();
	}

	public async getPrompt(name: string, args?: any) {
		await this.ensureConnected();
		return this.client.getPrompt(name, args);
	}

	public setBearerToken(token: string) {
		this.client.setBearerToken(token);
	}

	public async close() {
		if (this.isConnected) {
			await this.client.close();
			this.isConnected = false;
		}
	}

	public get name(): string {
		return this.client.name;
	}

	public get innerClient(): SimpleMcpClient | any {
		return this.client;
	}
}
