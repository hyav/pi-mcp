import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
const expectedTag = `v${packageJson.version}`;
const tagName = process.env.GITHUB_REF_NAME ?? process.env.RELEASE_TAG;

if (!changelog.split(/\r?\n/).some((line) => line.startsWith(`## ${packageJson.version} -`))) {
	throw new Error(`CHANGELOG.md has no release entry for ${packageJson.version}`);
}

if (!tagName) {
	console.log(`release identity ok outside CI; expected tag ${expectedTag}`);
	process.exit(0);
}

if (process.env.GITHUB_REF_TYPE && process.env.GITHUB_REF_TYPE !== "tag") {
	throw new Error(`release workflow must run from a tag, received ${process.env.GITHUB_REF_TYPE}`);
}
if (tagName !== expectedTag) {
	throw new Error(`release tag ${tagName} does not match package version ${packageJson.version}`);
}

if (process.env.GITHUB_ACTIONS === "true") {
	const commit = process.env.GITHUB_SHA;
	if (!commit) throw new Error("GitHub Actions did not provide GITHUB_SHA");
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"], { stdio: "ignore" });
	} catch {
		throw new Error(`release commit ${commit} is not reachable from origin/main`);
	}
}

console.log(`release identity ok: ${packageJson.name}@${packageJson.version} (${tagName})`);
