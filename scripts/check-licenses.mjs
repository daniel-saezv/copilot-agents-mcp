import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

const roots = JSON.parse(
  execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], { encoding: "utf8" }),
);
const paths = [];
collectPaths(roots);
const seen = new Map();

for (const packagePath of paths) {
  const manifest = JSON.parse(readFileSync(`${packagePath}/package.json`, "utf8"));
  const key = `${manifest.name}@${manifest.version ?? ""}`;
  if (seen.has(key)) continue;
  seen.set(key, licenseOf(manifest));
}

function licenseOf(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((item) => item.type).filter(Boolean).join(" OR ");
  }
  return "";
}

function expressionAllowed(expression) {
  const sides = expression.split(/\s+OR\s+/);
  return sides.some((side) => {
    const parts = side.replace(/[()]/g, " ").split(/\s+AND\s+/);
    return parts.every((part) => allowed.has(part.trim()));
  });
}

const blocked = [];
for (const [name, license] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!license || !expressionAllowed(license)) blocked.push(`${name} ${license || "(no license)"}`);
}

if (blocked.length > 0) {
  console.error(blocked.join("\n"));
  process.exit(1);
}

console.log(`Allowed production licenses: ${seen.size}`);

function collectPaths(nodes) {
  for (const node of nodes) {
    if (node.path && node.path.includes("node_modules")) paths.push(node.path);
    if (node.dependencies) collectPaths(Object.values(node.dependencies));
  }
}
