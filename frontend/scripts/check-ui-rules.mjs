// Machine checks for the UI rules. Fails with a list when a rule is broken.
// Run: npm run check:ui
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = join(root, "src");
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}
const all = files(src);
const rel = (path) => relative(root, path).replaceAll("\\", "/");

// ---------------------------------------------------------------- tokens and contrast
const tokensCss = readFileSync(join(src, "tokens.css"), "utf8");

function block(selector) {
  const start = tokensCss.indexOf(selector + " {");
  if (start < 0) return "";
  let depth = 0;
  for (let i = tokensCss.indexOf("{", start); i < tokensCss.length; i++) {
    if (tokensCss[i] === "{") depth++;
    if (tokensCss[i] === "}" && --depth === 0) return tokensCss.slice(start, i);
  }
  return "";
}
function vars(text) {
  const map = {};
  for (const match of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[match[1]] = match[2].trim();
  return map;
}
const lightVars = vars(block(":root"));
const darkVars = { ...lightVars, ...vars(block('[data-theme="dark"]')) };

function resolve(map, name, depth = 0) {
  let value = map[name];
  if (value === undefined || depth > 10) throw new Error(`unknown token ${name}`);
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(map, ref[1], depth + 1) : value;
}
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(toRgb(a)), lum(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Every text role against every ground it can sit on, in both themes. Body text needs 4.5.
const PAIRS = [
  ["--text", "--surface"], ["--text", "--canvas"], ["--text", "--raised"], ["--text", "--sunken"], ["--text", "--hover-bg"],
  ["--text-muted", "--surface"], ["--text-muted", "--canvas"], ["--text-muted", "--sunken"], ["--text-muted", "--raised"],
  // Links never sit on raised panels (menus, dialogs), so that pair is not tested.
  ["--placeholder", "--surface"], ["--link", "--surface"], ["--link", "--canvas"],
  ["--on-primary", "--primary"], ["--on-primary", "--primary-hover"], ["--on-primary", "--primary-pressed"],
  ["--selected-text", "--selected-bg"], ["--info-text", "--info-bg"],
  ["--good-text", "--good-bg"], ["--warn-text", "--warn-bg"], ["--bad-text", "--bad-bg"],
  ["--good-text", "--surface"], ["--warn-text", "--surface"], ["--bad-text", "--surface"],
  ["--warn-text", "--canvas"], ["--bad-text", "--canvas"],
  ["--toast-text", "--toast-bg"], ["--toast-error-text", "--toast-error-bg"], ["--white", "--bad-mark"], ["--neutral-900", "--warn-mark"],
  ["--text", "--changed-row"],
];
for (const [theme, map] of [["light", lightVars], ["dark", darkVars]]) {
  for (const [fg, bg] of PAIRS) {
    try {
      const value = ratio(resolve(map, fg), resolve(map, bg));
      if (value < 4.5) fail("tokens.css", `${theme}: ${fg} on ${bg} is ${value.toFixed(2)}:1, needs 4.5:1`);
    } catch (error) {
      fail("tokens.css", `${theme}: ${error.message}`);
    }
  }
}
// Primary 10 + neutral 10 + success, warning, error at 100/500/700 = 29, plus white.
// (The rules file says "23", but its own list adds up to 29.)
const palette = Object.entries(lightVars).filter(([name, value]) => /^#[0-9a-f]{6}$/i.test(value) && name !== "--white");
if (palette.length !== 29) fail("tokens.css", `palette has ${palette.length} colours, expected 29 plus white`);

// ---------------------------------------------------------------- source rules
const css = all.filter((path) => path.endsWith(".css") && !path.endsWith("tokens.css"));
const code = all.filter((path) => /\.(tsx?|css)$/.test(path) && !path.endsWith("tokens.css"));

for (const path of code) {
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, index) => {
    const where = `${rel(path)}:${index + 1}`;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/&#|href=|url\(#|#\/|"#"|`#|'#'|#main|#\$|\{ *#/.test(line)) fail(where, "colour literal outside tokens.css");
    if (/\brgba?\(|\bhsla?\(/.test(line)) fail(where, "colour function outside tokens.css");
    if (/transition:\s*all|transition-all/.test(line)) fail(where, "transition-all is banned");
    if (/backdrop-filter/.test(line)) fail(where, "backdrop-filter is banned");
    if (/window\.(confirm|alert|prompt)\(|\balert\(/.test(line)) fail(where, "browser dialogs are banned, use TwoStepButton");
    if (/style=\{\{[^}]*(color|background|border|shadow)/i.test(line)) fail(where, "colour in an inline style");
  });
}

for (const path of css) {
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, index) => {
    const where = `${rel(path)}:${index + 1}`;
    if (/\b(transition|animation)[^;{]*\b\d+(\.\d+)?m?s\b/.test(line) && !/(animation|transition)-duration:\s*1ms/.test(line)) fail(where, "literal duration, use a --dur-* token");
    if (/\b(?:padding|margin|gap)[^;{]*\b(?!1px|2px)\d+px/.test(line)) fail(where, "literal px in spacing, use a --space-* step");
    if (/\bz-index:\s*\d/.test(line)) fail(where, "literal z-index, use a --z-* token");
    if (/margin[^;]*var\(--space/.test(line) && /\.stack|\.content/.test(line)) fail(where, "margin on a block in a gap stack");
    if (/overflow-x:\s*auto/.test(line)) fail(where, "no sideways-scrolling tables, use the card list");
  });
  for (const frame of text.match(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) || []) {
    if (/(^|\s)(width|height|top|left|right|bottom|filter|background(-color)?)\s*:/.test(frame)) fail(rel(path), `keyframes animate more than opacity and transform: ${frame.split("{")[0].trim()}`);
  }
  // A grid with more than one column needs a one-column base for phones (mobile-first)
  const base = text.split("@media")[0];
  for (const match of base.matchAll(/([.\w-]+)\s*\{[^}]*grid-template-columns:\s*([^;]+);/g)) {
    const columns = match[2].trim();
    if (!/^(minmax\(0, 1fr\)|1fr|auto minmax\(0, 1fr\)|repeat\(2, minmax\(0, 1fr\)\))$/.test(columns) && !/minmax\(0, 8rem\)|minmax\(0, 1fr\) auto|minmax\(0, 1fr\) minmax\(0, 2fr\)|minmax\(0, 1fr\) minmax\(0, 1fr\)|minmax\(0, 8rem\) 1fr/.test(columns))
      fail(rel(path), `${match[1]} base grid has columns "${columns}" on a phone`);
  }
}

// One h1 per page: only the page header component and the customer page may write one
for (const path of all.filter((p) => p.endsWith(".tsx"))) {
  const text = readFileSync(path, "utf8");
  const count = (text.match(/<h1[\s>]/g) || []).length;
  const allowed = path.endsWith("components.tsx") ? 1 : path.endsWith("PayPage.tsx") ? 1 : 0;
  if (count !== allowed) fail(rel(path), `${count} <h1> found, ${allowed} allowed`);
}

// Every shared state has its text in both languages
const i18n = readFileSync(join(src, "i18n.tsx"), "utf8");
const keysOf = (start, end) => new Set([...i18n.slice(start, end).matchAll(/^\s{2}(\w+):\s*"/gm)].map((m) => m[1]));
const enStart = i18n.indexOf("const en = {");
const deStart = i18n.indexOf("const de:");
const dictEnd = i18n.indexOf("const DICTIONARY");
const en = keysOf(enStart, deStart);
const de = keysOf(deStart, dictEnd);
for (const key of en) if (!de.has(key)) fail("i18n.tsx", `"${key}" has no German text`);
for (const key of de) if (!en.has(key)) fail("i18n.tsx", `"${key}" has no English text`);

if (problems.length) {
  console.error(`UI rules: ${problems.length} problem(s)\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(`UI rules: all checks passed (${PAIRS.length * 2} contrast pairs in 2 themes, ${all.length} source files, ${en.size} texts in 2 languages)`);
