// Deploy this development tree into a profile's installed copy of the published package.
//
// Why a script: the dev tree keeps the `@shallbay/dsh-token-stats` identity it was
// linked with, while the installed package is `@shallbay/dsh-token-stats`. Copying files
// by hand ships the dev name inside the client bundle, and client-modules then refuses the
// row ("bundle executed twice" / "entry did not activate") because a bundle must register
// under its own package name. This script rewrites every shipped identifier to the TARGET
// package name and verifies the registration id afterwards.
//
//   node deploy.mjs                       # profile from $DSH_PROFILE (else desktop)
//   node deploy.mjs --profile web --home C:\Users\you\.dsh
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEV_NAME = "@shallbay/dsh-token-stats";
const root = import.meta.dirname;
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const home = argOf("--home", process.env.DSH_HOME || join(homedir(), ".dsh"));
const profile = argOf("--profile", process.env.DSH_PROFILE || "desktop");
const targetDir = join(home, "profiles", profile, "node_modules", "@shallbay", "dsh-token-stats");
if (!existsSync(join(targetDir, "package.json"))) throw new Error(`installed package not found: ${targetDir}`);
const target = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14);

const shipped = ["lib/index.js", "lib/client.js", "lib/dashboard.html", "cordis.patch.yml"];
for (const file of shipped) {
  const from = join(root, file);
  const to = join(targetDir, file);
  if (!existsSync(from)) throw new Error(`missing source file: ${file}`);
  if (existsSync(to)) copyFileSync(to, `${to}.bak-${stamp}`);
  writeFileSync(to, readFileSync(from, "utf8").split(DEV_NAME).join(target.name));
  console.log(`  ${file}  ->  ${to.replace(targetDir, "…")}`);
}

// Verification: a bundle must register under the package name the loader resolves.
const client = readFileSync(join(targetDir, "lib/client.js"), "utf8");
const registered = /id: "([^"]+)"/u.exec(client)?.[1];
if (registered !== target.name) throw new Error(`client bundle registers "${registered}", expected "${target.name}"`);
const cssTag = /const CSS_TAG = "([^"]+)"/u.exec(client)?.[1] ?? "";
if (!cssTag.startsWith(target.name)) throw new Error(`client CSS tag "${cssTag}" does not belong to ${target.name}`);
const host = readFileSync(join(targetDir, "lib/index.js"), "utf8");
if (!host.includes("catalog: catalogCache.items")) throw new Error("host half is missing the catalog payload");
const page = readFileSync(join(targetDir, "lib/dashboard.html"), "utf8");
if (!page.includes("id=\"pricingBtn\"")) throw new Error("page is missing the pricing button");

console.log(`\ndeployed to ${targetDir}`);
console.log(`  package   ${target.name}@${target.version}`);
console.log(`  bundle id ${registered}  (matches package name ✓)`);
console.log(`  backups   *.bak-${stamp}`);
console.log("  下一步：完全退出并重开 dsh（宿主模块只在启动时加载）");
