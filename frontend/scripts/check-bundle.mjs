// Size limits for what a browser downloads, measured gzipped from the built files (rules file, section 18).
// Raising a limit is a deliberate, explained edit in this file, never a reflex.
// Run after the build: npm run check:bundle (also part of npm run build)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dist = join(root, "dist");
const assets = join(dist, "assets");
const KB = 1024;

// What loads first for everyone (the entry script and the stylesheet), then each screen on its own.
const LIMITS = [
  // React and React DOM are about 45 KB of this; both languages' texts about 15 KB. Measured 70.3 KB on 9 Nov 2026.
  { name: "entry script (frame, shared parts, both languages)", match: (f) => f.startsWith("index-") && f.endsWith(".js"), limit: 75 * KB },
  { name: "stylesheet", match: (f) => f.startsWith("index-") && f.endsWith(".css"), limit: 16 * KB },
  { name: "customer page", match: (f) => f.startsWith("PayPage-") && f.endsWith(".js"), limit: 8 * KB },
  { name: "new invoice", match: (f) => f.startsWith("NewInvoice-") && f.endsWith(".js"), limit: 12 * KB },
  { name: "any other screen", match: (f) => f.endsWith(".js") && !f.startsWith("index-"), limit: 12 * KB },
  { name: "icon sprite", match: (f) => f.startsWith("icons-") && f.endsWith(".svg"), limit: 8 * KB },
];

const files = readdirSync(assets).filter((f) => statSync(join(assets, f)).isFile());
const problems = [];
const lines = [];
for (const file of files) {
  const rule = LIMITS.find((item) => item.match(file));
  if (!rule) continue;
  const size = gzipSync(readFileSync(join(assets, file))).length;
  lines.push(`  ${(size / KB).toFixed(1).padStart(6)} KB  ${file}  (limit ${rule.limit / KB} KB, ${rule.name})`);
  if (size > rule.limit) problems.push(`${file} is ${(size / KB).toFixed(1)} KB gzipped, over the ${rule.limit / KB} KB limit for the ${rule.name}`);
}
if (!files.some((f) => f.startsWith("PayPage-"))) problems.push("the customer page is not its own download (PayPage-*.js missing)");
console.log("Download sizes, gzipped:\n" + lines.sort().join("\n"));
if (problems.length) {
  console.error(`Size check: ${problems.length} problem(s)\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log("Size check: all within limits");
