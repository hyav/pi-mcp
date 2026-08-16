import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const headingPrefix = `## ${packageJson.version} -`;
const start = lines.findIndex((line) => line.startsWith(headingPrefix));

if (start < 0) {
	throw new Error(`CHANGELOG.md has no release entry for ${packageJson.version}`);
}

const nextHeading = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines
	.slice(start, nextHeading < 0 ? lines.length : nextHeading)
	.join("\n")
	.trim();
writeFileSync(join(repositoryRoot, "RELEASE_NOTES.md"), `${notes}\n`);
console.log(`release notes prepared for ${packageJson.name}@${packageJson.version}`);
