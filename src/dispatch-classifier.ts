/**
 * Determines whether an MCP tool can bypass the per-server mutation queue.
 * MCP annotations are authoritative; names and descriptions are untrusted prose.
 */
export function classifyExecutionMode(tool: {
	name?: string;
	description?: string;
	readOnlyHint?: boolean;
	annotations?: {
		readOnlyHint?: boolean;
	};
}): "parallel" | "sequential" {
	return tool.readOnlyHint === true || tool.annotations?.readOnlyHint === true ? "parallel" : "sequential";
}
