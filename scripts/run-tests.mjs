import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryHome = mkdtempSync(join(tmpdir(), "pi-mcp-test-home-"));
const executable = join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

try {
	execFileSync(executable, ["--test", "test/mcp.test.ts"], {
		cwd: repositoryRoot,
		stdio: "inherit",
		env: {
			...process.env,
			HOME: temporaryHome,
			USERPROFILE: temporaryHome,
			XDG_CACHE_HOME: join(temporaryHome, ".cache"),
			XDG_CONFIG_HOME: join(temporaryHome, ".config"),
		},
	});
} finally {
	rmSync(temporaryHome, { recursive: true, force: true });
}
