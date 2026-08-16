import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-mcp-artifact-"));
const nestedNpmEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"),
);
nestedNpmEnvironment.npm_config_dry_run = "false";

const requiredFiles = [
	"package.json",
	"index.ts",
	"src/index.ts",
	"src/config.ts",
	"src/cache.ts",
	"src/client.ts",
	"src/metadata.ts",
	"src/server-identity.ts",
	"src/proxy.ts",
	"src/stdio-transport.ts",
	"src/sse-transport.ts",
	"src/streamable-http-transport.ts",
	"README.md",
	"README.zh-CN.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"LICENSE",
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertArtifactFiles(files) {
	for (const file of requiredFiles) {
		if (!files.includes(file)) throw new Error(`npm artifact is missing ${file}`);
	}

	const forbiddenPrefixes = ["test/", "scripts/", ".pi/", "node_modules/"];
	for (const file of files) {
		if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
			throw new Error(`npm artifact contains repository-only path ${file}`);
		}
		if (
			file.includes(".DS_Store") ||
			file.endsWith(".tgz") ||
			file.split("/").some((part) => part.startsWith(".env"))
		) {
			throw new Error(`npm artifact contains local or generated state ${file}`);
		}
	}
}

async function run() {
	if (!existsSync(join(repositoryRoot, "node_modules"))) {
		throw new Error("node_modules is missing; run npm ci before checking the package artifact");
	}

	const repositoryPackage = readJson(join(repositoryRoot, "package.json"));
	const output = execFileSync("npm", ["pack", "--pack-destination", temporaryRoot, "--json", "--dry-run=false"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: nestedNpmEnvironment,
	});
	const metadata = JSON.parse(output)[0];
	if (!metadata?.filename || !Array.isArray(metadata.files)) throw new Error("npm pack returned invalid metadata");

	const artifactFiles = metadata.files.map(({ path }) => path);
	assertArtifactFiles(artifactFiles);

	const archivePath = join(temporaryRoot, metadata.filename);
	const consumerRoot = join(temporaryRoot, "consumer");
	mkdirSync(consumerRoot);
	writeFileSync(
		join(consumerRoot, "package.json"),
		`${JSON.stringify({ name: "pi-mcp-artifact-consumer", private: true, type: "module" })}\n`,
	);

	const peerNames = Object.keys(repositoryPackage.peerDependencies ?? {});
	for (const name of peerNames) {
		const testedVersion = repositoryPackage.devDependencies?.[name];
		const source = join(repositoryRoot, "node_modules", name);
		if (!testedVersion || !existsSync(source)) {
			throw new Error(`tested peer dependency ${name} is missing; run npm ci`);
		}
		if (readJson(join(source, "package.json")).version !== testedVersion) {
			throw new Error(`installed ${name} does not match tested version ${testedVersion}`);
		}
	}

	execFileSync(
		"npm",
		[
			"--prefix",
			consumerRoot,
			"install",
			"--offline",
			"--legacy-peer-deps",
			"--ignore-scripts",
			"--no-package-lock",
			"--no-save",
			"--no-fund",
			"--no-audit",
			archivePath,
		],
		{ stdio: "pipe", env: nestedNpmEnvironment },
	);

	for (const name of peerNames) {
		const source = join(repositoryRoot, "node_modules", name);
		const target = join(consumerRoot, "node_modules", name);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	}

	const packageRoot = join(consumerRoot, "node_modules", repositoryPackage.name);
	const installedPackage = readJson(join(packageRoot, "package.json"));
	if (installedPackage.name !== repositoryPackage.name || installedPackage.version !== repositoryPackage.version) {
		throw new Error("installed artifact identity does not match repository metadata");
	}
	if (typeof installedPackage.main !== "string" || !existsSync(join(packageRoot, installedPackage.main))) {
		throw new Error("installed artifact has no existing main entry point");
	}
	if (JSON.stringify(installedPackage.pi?.extensions) !== JSON.stringify(["./index.ts"])) {
		throw new Error("installed artifact has an unexpected Pi extension manifest");
	}

	const extensionPath = join(packageRoot, "index.ts");
	const result = await discoverAndLoadExtensions([extensionPath], packageRoot, packageRoot);
	if (result.errors.length > 0) {
		throw new Error(`published Pi entry point failed to load: ${JSON.stringify(result.errors)}`);
	}
	if (result.extensions.length !== 1)
		throw new Error(`expected one published Pi entry point, loaded ${result.extensions.length}`);

	console.log(`artifact ok: ${metadata.filename} (${artifactFiles.length} files, 1 Pi entry point)`);
}

try {
	await run();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
