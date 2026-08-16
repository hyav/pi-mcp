# @hyav/pi-mcp

[简体中文](README.zh-CN.md)

A lightweight [Pi](https://pi.dev) extension that routes one compact proxy tool to configured local and remote Model Context Protocol (MCP) servers. It caches capability metadata, opens connections on demand, and pools active transports.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Highlights

- Stdio, SSE, and Streamable HTTP transports
- Lazy connections and cached capability discovery
- Exact tool routing with explicit disambiguation for duplicate names
- Structured JSON arguments, cancellation, concurrency limits, and 10 MiB message bounds
- Redacted diagnostics and no persistent storage of expanded credentials

## Install

Requires Node.js 22.19.0 or newer and Pi.

```sh
pi install npm:@hyav/pi-mcp
```

Start Pi and run `/mcp`. A successful installation opens the connection panel and lists discovered servers.

## Configure

The preferred global file is `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "API_KEY": "${LOCAL_MCP_API_KEY}" }
    },
    "remote": {
      "url": "https://mcp.example.test/mcp",
      "type": "streamable-http",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" }
    }
  },
  "settings": {
    "enableLocalConfig": false,
    "enableThirdPartyConfig": false
  }
}
```

Each server must define exactly one of `command` or `url`. Stdio definitions may set `args`, `cwd`, `env`, timeouts, concurrency, and protocol mode; remote definitions may set `type`, headers, and Bearer authentication. Use environment placeholders or `bearerTokenEnv` instead of literal credentials.

The fallback global path is `~/.config/mcp/mcp.json`. Trusted project files (`.pi/mcp.json` or `.mcp.json`) and supported third-party configurations are read only when the corresponding global opt-in is enabled. Global definitions override third-party imports, trusted project definitions override both, and explicit custom definitions have highest priority.

## Use

- `/mcp`: open the connection panel
- `/mcp <server>`: connect or disconnect a server
- `/mcp reconnect <server>`: reconnect and refresh metadata

The Agent-facing `mcp` proxy searches capabilities, reports status, connects servers, invokes exact tools, and lists or reads resources. Duplicate tool names require an explicit server. Public metadata may be cached in `~/.pi/agent/mcp-cache.json`; private metadata and authorization fingerprints remain in memory.

## Before you use it

Stdio servers run local commands; remote servers receive the data and credentials sent to them. Install and configure only trusted code and services.

## License

[MIT](LICENSE)
