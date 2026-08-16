# Changelog

This file is the authoritative user-facing release history for `@hyav/pi-mcp`.

## 0.1.2 - 2026-08-17

- Fixed `-32022` (`UnsupportedProtocolVersionError`) negotiation: the server's `error.data.supported` version list is now propagated, so a server that claims to support the requested protocol version surfaces the error instead of silently falling back to the legacy handshake.
- Runtime files (`mcp.log`, `mcp-cache.json`, `mcp-trusted-workspaces.json`) moved from the agent config directory root into `<agent-dir>/extensions/pi-mcp/`, with a one-time automatic migration of existing files.
- The MCP client now identifies itself as `pi-mcp` in `clientInfo`, replacing the former `pi-mcp-kit` name.

## 0.1.1 - 2026-08-16

- Improved release verification with automated remote reference resolution.

## 0.1.0 - 2026-08-16

- Initial public release of `@hyav/pi-mcp`.
- Pi extension for routing one proxy tool to local and remote MCP servers.
- Stdio, SSE, and Streamable HTTP transports with lazy connections, capability caching, pooling, and cancellation.
- Bounded MCP messages and output, trusted configuration loading, and credential-redacted diagnostics.
