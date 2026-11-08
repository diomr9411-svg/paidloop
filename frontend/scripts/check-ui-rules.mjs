// Machine checks for the UI rules (docs/UI-RULES-APPLIED.md). Fails with a list when a rule is broken.
// Run: npm run check:ui (also part of npm run build)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

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
const read = (path) => readFileSync(path, "utf8");

// Screens written before these rules, still being moved over. This list only shrinks (a ratchet);
// a file on it skips the stricter rules marked "strict" below. Delete the list when it is empty.
const LEGACY = new Set([]);
const strict = (path) => !LEGACY.has(rel(path));

// ---------------------------------------------------------------- tokens and contrast
const tokensCss = read(join(src, "tokens.css"));

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

const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const toRgb = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

/** A colour token as #rrggbb. Follows var() and works out color-mix(in srgb, A p%, B), like the browser does. */
function colour(map, value, depth = 0) {
  if (depth > 12) throw new Error(`too deep: ${value}`);
  value = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) {
    if (map[ref[1]] === undefined) throw new Error(`unknown token ${ref[1]}`);
    return colour(map, map[ref[1]], depth + 1);
  }
  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)(?:\s+(\d+(?:\.\d+)?)%)?\s*\)$/);
  if (mix) {
    if (/transparent/.test(mix[1] + mix[3])) throw new Error(`see-through colour can't be measured: ${value}`);
    const p = Number(mix[2]) / 100;
    const q = mix[4] === undefined ? 1 - p : Number(mix[4]) / 100;
    const a = toRgb(colour(map, mix[1], depth + 1));
    const b = toRgb(colour(map, mix[3], depth + 1));
    return hex(a.map((v, i) => (v * p + b[i] * q) / (p + q)));
  }
  throw new Error(`can't measure colour "${value}"`);
}
const lum = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(toRgb(a)), lum(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Every text role against every ground it can sit on, in both themes. Text needs 4.5:1.
const TEXT_PAIRS = [
  ["--text", "--surface"], ["--text", "--canvas"], ["--text", "--raised"], ["--text", "--sunken"], ["--text", "--hover-bg"],
  ["--text", "--paper"], ["--text", "--band"], ["--text", "--brand-surface"], ["--text", "--selected-bg"],
  ["--text-muted", "--surface"], ["--text-muted", "--canvas"], ["--text-muted", "--sunken"], ["--text-muted", "--raised"],
  ["--text-muted", "--band"], ["--text-muted", "--brand-surface"], ["--text-muted", "--paper"],
  // Links never sit on raised panels (menus, dialogs), so that pair is not tested.
  ["--placeholder", "--surface"], ["--link", "--surface"], ["--link", "--canvas"], ["--link", "--paper"], ["--link", "--brand-surface"],
  ["--brand", "--surface"],
  ["--on-primary", "--primary"], ["--on-primary", "--primary-hover"], ["--on-primary", "--primary-pressed"],
  ["--selected-text", "--selected-bg"], ["--info-text", "--info-bg"], ["--tile-text", "--tile-bg"],
  ["--good-text", "--good-bg"], ["--warn-text", "--warn-bg"], ["--bad-text", "--bad-bg"],
  ["--good-text", "--surface"], ["--warn-text", "--surface"], ["--bad-text", "--surface"],
  ["--warn-text", "--canvas"], ["--bad-text", "--canvas"], ["--bad-text", "--brand-surface"],
  ["--text", "--bad-bg"], ["--text", "--warn-bg"], ["--text-muted", "--bad-bg"], ["--text-muted", "--warn-bg"], ["--warn-text", "--raised"],
  ["--tooltip-text", "--tooltip-bg"], ["--toast-text", "--toast-bg"], ["--toast-error-text", "--toast-error-bg"],
  ["--white", "--bad-mark"], ["--neutral-900", "--warn-mark"],
  ["--text", "--changed-row"],
];
// Shapes that carry meaning (focus ring, bars) need 3:1 against what is around them.
const SHAPE_PAIRS = [
  ["--focus", "--surface"], ["--focus", "--canvas"], ["--focus", "--raised"],
  ["--bar", "--surface"], ["--primary", "--surface"], ["--placeholder", "--surface"],
];
for (const [theme, map] of [["light", lightVars], ["dark", darkVars]]) {
  for (const [pairs, need] of [[TEXT_PAIRS, 4.5], [SHAPE_PAIRS, 3]]) {
    for (const [fg, bg] of pairs) {
      try {
        const value = ratio(colour(map, `var(${fg})`), colour(map, `var(${bg})`));
        if (!(value >= need)) fail("tokens.css", `${theme}: ${fg} on ${bg} is ${value.toFixed(2)}:1, needs ${need}:1`);
      } catch (error) {
        fail("tokens.css", `${theme}: ${fg} on ${bg}: ${error.message}`);
      }
    }
  }
}
// Every colour role must be measurable (a typo in a mix would otherwise pass unseen).
for (const [theme, map] of [["light", lightVars], ["dark", darkVars]]) {
  for (const [name, value] of Object.entries(map)) {
    if (!/#|color-mix|^var\(--(white|primary|neutral|success|warning|error)/.test(value) || /transparent/.test(value) || name.startsWith("--elev")) continue;
    try {
      colour(map, value);
    } catch (error) {
      fail("tokens.css", `${theme}: ${name}: ${error.message}`);
    }
  }
}
// Primary 10 + neutral 10 + success, warning, error at 100/500/700 = 29, plus white.
// (The rules file says "23", but its own list adds up to 29.)
const palette = Object.entries(lightVars).filter(([name, value]) => /^#[0-9a-f]{6}$/i.test(value) && name !== "--white");
if (palette.length !== 29) fail("tokens.css", `palette has ${palette.length} colours, expected 29 plus white`);

// ---------------------------------------------------------------- styles
const css = all.filter((path) => path.endsWith(".css") && !path.endsWith("tokens.css") && !path.endsWith("fonts.css"));
const code = all.filter((path) => /\.(tsx?|css)$/.test(path) && !path.endsWith("tokens.css"));

for (const path of code) {
  read(path).split("\n").forEach((line, index) => {
    const where = `${rel(path)}:${index + 1}`;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/&#|href=|url\(#|#\/|"#"|`#|'#'|#main|#\$|\{ *#|#connections|`\$\{sprite\}#|#\$\{/.test(line)) fail(where, "colour literal outside tokens.css");
    if (/\brgba?\(|\bhsla?\(/.test(line)) fail(where, "colour function outside tokens.css");
    if (/transition:\s*all|transition-all/.test(line)) fail(where, "transition-all is banned");
    if (/backdrop-filter/.test(line)) fail(where, "backdrop-filter is banned");
    if (/window\.(confirm|alert|prompt)\(|\balert\(/.test(line)) fail(where, "browser dialogs are banned, use ConfirmDialog");
    if (/style=\{\{[^}]*(color|background|border|shadow)/i.test(line)) fail(where, "colour in an inline style");
    if (/style=\{\{[^}]*\d(px|rem|em)\b/.test(line)) fail(where, "size in an inline style, use a token");
    if (/eslint-disable/.test(line) && !/eslint-disable[\w-]*\s+[\w/@-]+(,\s*[\w/@-]+)*\s+--\s+\S/.test(line)) fail(where, 'a lint rule switched off without a written reason (add "-- because ...")');
  });
}

const SIZE_PROPS = /^(width|height|min-width|max-width|min-height|max-height|flex-basis|inset|top|left|right|bottom|grid-template-columns|grid-template-rows|grid-auto-columns|grid-auto-rows)$/;
for (const path of css) {
  const text = read(path);
  // Each declaration, with the line it starts on
  const declarations = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+)/g)) declarations.push({ prop: match[1], value: match[2].trim(), where: `${rel(path)}:${index + 1}` });
  });
  for (const { prop, value, where } of declarations) {
    if (/^(transition|animation)/.test(prop) && /\b\d+(\.\d+)?m?s\b/.test(value) && !/^(animation|transition)-duration$/.test(prop)) fail(where, "literal duration, use a --dur-* token");
    if (/^(padding|gap|row-gap|column-gap)/.test(prop) && /\b\d+(\.\d+)?(px|rem|em)\b/.test(value.replace(/\b[12]px\b/g, ""))) fail(where, `literal size in ${prop}, use a --space-* step`);
    if (prop === "z-index" && /^\d/.test(value)) fail(where, "literal z-index, use a --z-* token");
    if (prop === "overflow-x" && value === "auto") fail(where, "no sideways-scrolling tables, use the card list");
    if (!strict(path)) continue;
    // strict rules
    if (/^margin/.test(prop) && !/^(0|auto|0 auto|auto 0|0 0 0 auto)$/.test(value)) fail(where, `margin "${value}": space blocks with the parent's gap, not margins`);
    if (SIZE_PROPS.test(prop) && /\b\d+(\.\d+)?(px|rem|em)\b/.test(value.replace(/^1px$/, "").replace(/-?\b[12]px\b/g, ""))) fail(where, `literal size in ${prop}: "${value}", add a size token`);
    if (prop === "border-radius" && !/^((var\(--radius[\w-]*\)|0)\s*)+$/.test(value)) fail(where, `radius "${value}", use a --radius-* token`);
    if (prop === "font-size" && !/^(var\(--text-[\w]+\)|inherit)$/.test(value)) fail(where, `font size "${value}", use a --text-* token`);
    if (prop === "line-height" && !/^(var\(--line-[\w]+\)|inherit)$/.test(value)) fail(where, `line height "${value}", use a --line-* token`);
    if (prop === "letter-spacing" && !/^(var\(--tracking-[\w]+\)|0|normal)$/.test(value)) fail(where, `letter spacing "${value}", use a --tracking-* token`);
    if (prop === "box-shadow" && !/^(var\(--elev-[\w]+\)|none)$/.test(value)) fail(where, `shadow "${value}", use an --elev-* token`);
    if (prop === "font-weight" && !/^(var\(--weight-[\w]+\)|inherit)$/.test(value)) fail(where, `font weight "${value}", use a --weight-* token`);
  }
  for (const frame of text.match(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) || []) {
    if (/(^|\s)(width|height|top|left|right|bottom|filter|background(-color)?)\s*:/.test(frame)) fail(rel(path), `keyframes animate more than opacity and transform: ${frame.split("{")[0].trim()}`);
  }
  // A grid with more than one column needs a one-column base for phones (mobile-first).
  // A few small two- and three-part rows (icon + text, label + value) are fine on any phone.
  const PHONE_SAFE = /^(auto minmax\(0, 1fr\)|minmax\(0, 1fr\) auto|auto minmax\(0, 1fr\) auto|var\(--[\w-]+\) minmax\(0, 1fr\)|var\(--[\w-]+\) minmax\(0, 1fr\) var\(--[\w-]+\)|minmax\(0, 1fr\) var\(--[\w-]+\)|repeat\(2, minmax\(0, 1fr\)\))$/;
  // Rules outside every @media block are what a phone gets
  const base = text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const match of base.matchAll(/([^{}]+)\{[^}]*grid-template-columns:\s*([^;]+);/g)) {
    const columns = match[2].trim();
    if (trackCount(columns) > 1 && !PHONE_SAFE.test(columns)) fail(rel(path), `${match[1].trim()} base grid has columns "${columns}" on a phone`);
  }
}

/** How many columns a grid template makes, counting repeat(n, ...). */
function trackCount(value) {
  const parts = [];
  let depth = 0;
  let token = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (/\s/.test(c) && depth === 0) {
      if (token) parts.push(token);
      token = "";
    } else token += c;
  }
  if (token) parts.push(token);
  return parts.reduce((n, part) => {
    const repeat = part.match(/^repeat\((\d+),/);
    return n + (repeat ? Number(repeat[1]) : part.startsWith("repeat(") ? 2 : 1);
  }, 0);
}

// ---------------------------------------------------------------- screens (tsx)
const tsx = all.filter((p) => p.endsWith(".tsx"));
const H1_FILES = new Set(["src/ui/PageHeader.tsx", "src/pages/PayPage.tsx"]);

/** Every opening tag of an element written in lower case (a real HTML element), with its attributes. */
function intrinsicTags(text) {
  const tags = [];
  for (const match of text.matchAll(/<([a-z][\w-]*)\b/g)) {
    let depth = 0;
    let quote = "";
    let i = match.index + match[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({ tag: match[1], attributes: text.slice(match.index + match[0].length, i), line: text.slice(0, match.index).split("\n").length });
  }
  return tags;
}

for (const path of tsx) {
  const text = read(path);
  const name = rel(path);
  const count = (text.match(/<h1[\s>]/g) || []).length;
  const allowed = H1_FILES.has(name) ? 1 : 0;
  if (count !== allowed) fail(name, `${count} <h1> found, ${allowed} allowed (the page header writes the one h1)`);
  if (!strict(path)) continue;
  for (const { tag, attributes, line } of intrinsicTags(text)) {
    if (/(^|\s)title=/.test(attributes) && tag !== "abbr") fail(`${name}:${line}`, `<${tag} title=...>: the browser's own tooltip, use the Tooltip part`);
    if (tag === "button" && !name.startsWith("src/ui/")) fail(`${name}:${line}`, "a raw <button>: use the Button part from src/ui/Button.tsx");
  }
}

// ---------------------------------------------------------------- tiers: nothing imports upward
// helpers (api, i18n, assets) <- ui (visual only) <- widgets (business-aware parts) <- pages (screens)
// <- shell and the route list (the frame) <- App and main (the entry)
function tier(name) {
  if (/^src\/(api|i18n)(\.tsx?)?$/.test(name) || name.startsWith("src/assets/")) return -1;
  if (name.startsWith("src/ui/")) return 0;
  if (name.startsWith("src/widgets/")) return 1;
  if (name.startsWith("src/pages/")) return 2;
  if (name.startsWith("src/shell/") || /^src\/routes(\.ts)?$/.test(name)) return 3;
  return 4;
}
for (const path of all.filter((p) => /\.tsx?$/.test(p))) {
  const name = rel(path);
  for (const match of read(path).matchAll(/from\s+"(\.{1,2}\/[^"?]+)[^"]*"/g)) {
    const target = rel(join(dirname(path), match[1]));
    if (name.startsWith("src/ui/") && /^src\/api/.test(target)) fail(name, `imports ${match[1]}: the ui parts are visual only, no data`);
    if (tier(target) > tier(name)) fail(name, `imports ${match[1]}, which sits in a higher tier`);
    if (name.startsWith("src/pages/") && dirname(target) === "src/pages" && target !== name.replace(/\.tsx?$/, "")) fail(name, `imports another page (${match[1]}); share it through src/widgets`);
  }
}

// ---------------------------------------------------------------- the route list covers every page, both ways
const routesFile = join(src, "routes.ts");
if (!existsSync(routesFile)) fail("src/routes.ts", "missing: one list of every screen");
else {
  const listed = new Set([...read(routesFile).matchAll(/page:\s*"(\w+)"/g)].map((m) => m[1]));
  const pages = new Set(readdirSync(join(src, "pages")).filter((n) => n.endsWith(".tsx")).map((n) => basename(n, ".tsx")));
  for (const page of pages) if (!listed.has(page)) fail("src/routes.ts", `page ${page} has no route`);
  for (const page of listed) if (!pages.has(page)) fail("src/routes.ts", `route points to a missing page ${page}`);
}

// ---------------------------------------------------------------- every icon name has a drawing
const iconList = read(join(src, "ui", "icon-names.ts"));
const sprite = existsSync(join(src, "assets", "icons.svg")) ? read(join(src, "assets", "icons.svg")) : "";
const iconNames = [...iconList.slice(iconList.indexOf("[")).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
for (const icon of iconNames) if (!sprite.includes(`<symbol id="${icon}"`)) fail("src/assets/icons.svg", `no drawing for "${icon}", run npm run icons`);

// ---------------------------------------------------------------- every text in both languages
const i18n = read(join(src, "i18n.tsx"));
const keysOf = (start, end) => new Set([...i18n.slice(start, end).matchAll(/^\s{2}(\w+):\s*["'`]/gm)].map((m) => m[1]));
const enStart = i18n.indexOf("const en = {");
const deStart = i18n.indexOf("const de:");
const dictEnd = i18n.indexOf("const DICTIONARY");
const en = keysOf(enStart, deStart);
const de = keysOf(deStart, dictEnd);
for (const key of en) if (!de.has(key)) fail("i18n.tsx", `"${key}" has no German text`);
for (const key of de) if (!en.has(key)) fail("i18n.tsx", `"${key}" has no English text`);

if (LEGACY.size) console.log(`UI rules: ${LEGACY.size} older file(s) still on the exemption list: ${[...LEGACY].join(", ")}`);
if (problems.length) {
  console.error(`UI rules: ${problems.length} problem(s)\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(
  `UI rules: all checks passed (${(TEXT_PAIRS.length + SHAPE_PAIRS.length) * 2} contrast pairs in 2 themes, ${all.length} source files, ${iconNames.length} icons, ${en.size} texts in 2 languages)`,
);
