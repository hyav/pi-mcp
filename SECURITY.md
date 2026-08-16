# Security Policy

`@hyav/pi-mcp` is a Pi extension. Its TypeScript source runs with the user's system privileges and can spawn configured subprocesses, connect to remote MCP endpoints, and forward configured environment variables and headers. Review the source and package artifact before installing extensions from untrusted sources.

Project configuration is executable input and is loaded only when both `enableLocalConfig` is enabled and Pi marks the workspace trusted. Cursor, Claude Code, and Claude Desktop definitions are disabled by default; enabling `enableThirdPartyConfig` in the global config explicitly extends trust to those files. Stdio children receive a minimal system/proxy/CA environment plus only explicitly configured business variables.

Persistent metadata contains only unexpired public tool/resource descriptions and a credential-free server fingerprint. Private metadata and authorization-context fingerprints stay in memory. Expanded server definitions, environment values, headers, and bearer credentials are not persisted. Logs apply structural and configured-value redaction, but users should still remove sensitive data before sharing them.

## Supported versions

| Version or branch | Support |
|---|---|
| Latest published release | Best-effort security fixes |
| Older published releases | Not supported |
| Unreleased `main` | No compatibility or response-time promise |

There is no long-term-support branch. Upgrade to the latest release before reporting whether an issue is still present.

## Reporting a vulnerability

Do **not** report suspected vulnerabilities in a public issue, pull request, chat, or forum.

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/hyav/pi-mcp/security/advisories/new). Include:

- affected package version, commit, or published artifact;
- reproduction steps or a minimal proof of concept;
- impact, prerequisites, and affected trust boundary;
- logs or traces with credentials, tokens, private endpoints, and personal data removed;
- a safe way to contact you for follow-up.

## Response and disclosure

Reports are handled on a best-effort basis; no acknowledgement, remediation, or disclosure deadline is guaranteed. The maintainer will coordinate a fix and public disclosure when affected users have a reasonable mitigation or upgrade path. Please do not publish details before then.

## Scope

This policy covers the source repository, the published `@hyav/pi-mcp` npm artifact, configuration loading, tool routing, stdio/SSE/Streamable HTTP transports, metadata caching, and bounded output handling. Vulnerabilities in Pi, an MCP server, npm, GitHub, or another dependency should also be reported to the relevant upstream maintainer.

For ordinary defects and usage questions, use the [public issue tracker](https://github.com/hyav/pi-mcp/issues).

