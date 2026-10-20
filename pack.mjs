// Build the publish-ready npm package under dist/.
//
// The development copy in this folder keeps the `@deepseek-ai/...` identity it was
// linked into a local profile with; the published package is `@shallbay/dsh-token-stats`
// and every shipped reference to the package name is rewritten here.
//
//   node pack.mjs            # version from package.json
//   node pack.mjs 1.2.0      # explicit version
//
// Then: cd dist && npm publish --access public
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Identity of this development copy (matches the profile link + bundle row). */
const SOURCE_NAME = "@deepseek-ai/dsh-token-stats";
/** Identity published to npm. */
const PUBLISH_NAME = "@shallbay/dsh-token-stats";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv[2] ?? manifest.version;
const dist = join(root, "dist");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`not a semver version: ${version}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "lib"), { recursive: true });

const shipped = ["lib/index.js", "lib/client.js", "lib/dashboard.html", "cordis.patch.yml", "install.ps1", "LICENSE"];
for (const file of shipped) {
  const from = join(root, file);
  if (!existsSync(from)) throw new Error(`missing file to ship: ${file}`);
  copyFileSync(from, join(dist, file));
}

delete manifest.private;
manifest.name = PUBLISH_NAME;
manifest.version = version;
manifest.keywords = ["dsh", "deepseek-harness", "token", "usage", "dashboard", "plugin"];
manifest.publishConfig = { access: "public" };
manifest.files = shipped;
writeFileSync(join(dist, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

// The client bundle registers itself under its package name, so the identity has to
// match the installed/selected bundle name exactly.
for (const file of ["lib/client.js", "lib/index.js", "cordis.patch.yml", "install.ps1"]) {
  const path = join(dist, file);
  writeFileSync(path, readFileSync(path, "utf8").split(SOURCE_NAME).join(PUBLISH_NAME));
}

// README travels as-is (it already documents the npm install/upgrade/uninstall commands);
// only the package identity is rewritten to the publish name and the repository-only
// "dev-only" note is stripped.
const readme = readFileSync(join(root, "README.md"), "utf8")
  .replace(/<!-- dev-only -->[\s\S]*?<!-- \/dev-only -->\n\n?/u, "")
  .split(SOURCE_NAME).join(PUBLISH_NAME);
writeFileSync(join(dist, "README.md"), readme);

const client = readFileSync(join(dist, "lib/client.js"), "utf8");
const registered = /id: "([^"]+)"/u.exec(client)?.[1];
if (registered !== PUBLISH_NAME) throw new Error(`client bundle registers "${registered}", expected "${PUBLISH_NAME}"`);
if (!readFileSync(join(dist, "cordis.patch.yml"), "utf8").includes(PUBLISH_NAME)) throw new Error("bundle patch does not name the published package");

// Release checks: the artifact must carry the current dashboard and host behaviour.
const shippedPage = readFileSync(join(dist, "lib/dashboard.html"), "utf8");
const shippedHost = readFileSync(join(dist, "lib/index.js"), "utf8");
const checks = [
  ["client popup is light", client.includes("background:#f4f6fb")],
  ["client refreshes its injected CSS", client.includes("if (existing === null) document.head.appendChild(tag)")],
  ["page uses the light palette", shippedPage.includes("--bg: #f4f6fb")],
  ["page keeps 5 stats per row", shippedPage.includes("grid-template-columns: repeat(5, 1fr)")],
  ["page cards stack (no grid-top)", !shippedPage.includes("grid-top")],
  ["page has the pricing button", shippedPage.includes('id="pricingBtn"')],
  ["pricing table shows provider + model columns", shippedPage.includes('<th rowspan="2">供应商</th>') && shippedPage.includes('<th rowspan="2">模型</th>')],
  ["pricing table groups 3 metrics x 2 tiers", (shippedPage.match(/空闲时段<\/th><th>高峰时段<\/th>/gu) ?? []).length === 3],
  ["pricing resolves names from the host catalog", shippedPage.includes("function catalogNames(")],
  ["pricing persists per model", shippedPage.includes("dsh-token-stats/pricing/v1")],
  ["pricing costs every record by its own model", shippedPage.includes("costParts(modelKeyOf(r)")],
  ["default price: cache hit 0.02 / 0.04", /cacheHit: \{ off: 0\.02, peak: 0\.04 \}/u.test(shippedPage)],
  ["default price: cache miss 1 / 2", /cacheMiss: \{ off: 1, peak: 2 \}/u.test(shippedPage)],
  ["default price: output 4 / 8", /output: \{ off: 4, peak: 8 \}/u.test(shippedPage)],
  ["host reads versioned session logs", shippedHost.includes("SESSION_LOG_RE")],
  ["host isolates the rollup per profile", shippedHost.includes("token-stats-rollup.")],
  ["host folds retry attempts", shippedHost.includes("createSlotTracker")],
  ["host re-reads the page by mtime", shippedHost.includes("function dashboardHtml()")],
  ["host attributes each record to its model", shippedHost.includes("function modelOfEvent(")],
  ["host exposes the provider/model catalog", shippedHost.includes("catalog: catalogCache.items")],
  ["description keeps its label", manifest.description.includes("Token 用量")],
  ["manifest is not private", manifest.private === undefined],
  ["readme documents the npm install command", readme.includes(`add ${PUBLISH_NAME}`)],
  ["readme documents the npm uninstall command", readme.includes(`remove ${PUBLISH_NAME}`)],
  ["readme names the published package", readme.includes(PUBLISH_NAME)],
  ["readme drops repository-only notes", !readme.includes("dev-only") && !readme.includes(SOURCE_NAME)],
  ["readme covers install/upgrade/uninstall", ["## 安装", "## 升级", "## 卸载"].every((heading) => new RegExp(`^${heading}$`, "mu").test(readme))]
];
const failed = checks.filter(([, ok]) => !ok);

console.log(`built ${dist}`);
console.log(`  name    ${manifest.name}`);
console.log(`  version ${manifest.version}`);
console.log(`  files   ${shipped.join(", ")}`);
for (const [label, ok] of checks) console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}`);
if (failed.length > 0) throw new Error(`${failed.length} release check(s) failed`);
console.log("next: cd dist && npm pack  →  npm publish --access public");
console.log("      (凭据与 registry 走用户级 %USERPROFILE%\\.npmrc，见 RELEASE.md)");
