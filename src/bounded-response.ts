export const MAX_MCP_RESPONSE_BYTES = 10 * 1024 * 1024;

export function serializeBoundedMcpPayload(
	payload: Record<string, unknown>,
	maxBytes = MAX_MCP_RESPONSE_BYTES,
): string {
	const serialized = JSON.stringify(payload);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new Error(`PAYLOAD_TOO_LARGE: MCP message exceeds the ${maxBytes}-byte safety limit.`);
	}
	return serialized;
}

export async function readBoundedResponseText(response: Response, maxBytes = MAX_MCP_RESPONSE_BYTES): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel("response too large").catch(() => {});
		throw new Error(`PAYLOAD_TOO_LARGE: HTTP response exceeds the ${maxBytes}-byte safety limit.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel("response too large").catch(() => {});
				throw new Error(`PAYLOAD_TOO_LARGE: HTTP response exceeds the ${maxBytes}-byte safety limit.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}
