// Builds the one icon file the screens use (src/assets/icons.svg) from the names in src/ui/icon-names.ts.
// Only the listed icons go in, so the app ships a few KB instead of the whole set.
// The drawings come from Lucide (ISC licence). Line colour and width are set by CSS, so dark mode and sizes just work.
// Run: npm run icons
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const list = readFileSync(join(root, "src", "ui", "icon-names.ts"), "utf8");
const names = [...list.slice(list.indexOf("[")).matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
if (new Set(names).size !== names.length) throw new Error("icon-names.ts lists a name twice");

const version = JSON.parse(readFileSync(join(root, "node_modules", "lucide", "package.json"), "utf8")).version;
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const symbols = [];
for (const name of names) {
  const file = join(root, "node_modules", "lucide", "dist", "esm", "icons", `${name}.mjs`);
  let node;
  try {
    node = (await import(pathToFileURL(file).href)).default;
  } catch {
    throw new Error(`Lucide has no icon called "${name}". Pick another name at lucide.dev/icons.`);
  }
  const shapes = node.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}/>`);
  symbols.push(`<symbol id="${name}" viewBox="0 0 24 24">${shapes.join("")}</symbol>`);
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg">`,
  `<!-- ${names.length} icons from Lucide ${version} (lucide.dev), ISC licence. Built by scripts/build-icons.mjs from src/ui/icon-names.ts; do not edit by hand. -->`,
  ...symbols,
  `</svg>`,
  "",
].join("\n");
writeFileSync(join(root, "src", "assets", "icons.svg"), svg);
console.log(`Icons: wrote ${names.length} icons to src/assets/icons.svg (${(svg.length / 1024).toFixed(1)} KB)`);
