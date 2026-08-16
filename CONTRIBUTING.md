# Contributing

Thank you for helping improve `@hyav/pi-mcp`. The canonical user contract is in [README.md](README.md); the extension entry point is [`index.ts`](index.ts).

## Before you start

- Search existing [GitHub issues](https://github.com/hyav/pi-mcp/issues) before opening a new one.
- For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of using a public issue.
- Keep changes focused. Do not commit credentials, personal data, local MCP configuration, generated output, or unrelated formatting changes.

## Development setup

Use Node.js `22.19.0` or later with npm. The tested Pi host baseline is `0.84.1`:

```sh
npm ci --ignore-scripts
```

Pi loads the published TypeScript source through its extension loader. Do not add a compiled `dist/` tree unless the package contract is deliberately changed and documented.

## Required checks

Run the same deterministic gate used by CI:

```sh
npm run audit:runtime
npm run audit:all
npm run check
npm test
npm run artifact:check
```

- `npm run audit:runtime` checks the published dependency boundary for high-severity advisories.
- `npm run audit:all` also checks the development and tested-host dependency tree.
- `npm run check` runs Biome and TypeScript type checking.
- `npm test` uses an isolated temporary home directory and exercises local mock MCP subprocesses and loopback HTTP servers.
- `npm run artifact:check` builds a real npm tarball, rejects repository-only files, installs it in a temporary consumer, and loads the published Pi entry point.

The ordinary gate must not connect to configured MCP servers or require credentials.

## Changes and review

- Public behavior changes must include behavior-focused tests and documentation updates.
- Keep `README.md` canonical and update `README.zh-CN.md` when user-visible behavior changes.
- Update [CHANGELOG.md](CHANGELOG.md) for release-relevant behavior, compatibility, security, or migration changes.
- Preserve the source-package boundary in `package.json.files`; tests, mock servers, scripts, and local `.pi/` state must not enter the npm artifact.
- Treat commands, environment variables, headers, server responses, and tool output as security-sensitive input. Keep resource limits, cancellation, and exact mutation routing intact.

## Reporting defects

Use a public [GitHub issue](https://github.com/hyav/pi-mcp/issues) for ordinary defects and include, when safe:

- package version or commit;
- Node.js, Pi, and MCP server versions;
- transport type and installation method;
- expected and actual behavior;
- a minimal reproduction and redacted logs.

Do not disclose vulnerability details or credentials publicly; use [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).

