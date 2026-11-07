// Walks every screen at 5 widths in a real Chrome, with no extra packages except axe-core.
// Needs the app running (default http://127.0.0.1:8000) with demo data.
// Run: npm run walk            (SHOTS=folder saves a few screenshots)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.UI_URL || "http://127.0.0.1:8000";
const PORT = 9333 + Math.floor(Math.random() * 400);
const SHOTS = process.env.SHOTS || "";
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((path) => path && existsSync(path));
if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const WIDTHS = [320, 375, 768, 1024, 1440];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ what to visit
const api = async (path) => (await fetch(BASE + path)).json();
const list = (await api("/api/invoices?size=100")).items;
const open = list.find((row) => row.status === "issued");
const paid = list.find((row) => row.status === "paid");
if (!open) throw new Error("No open invoice. Reset the demo data first.");
const token = (await api(`/api/invoices/${open.id}`)).public_token;
const ROUTES = [
  ["home", "#/"],
  ["new", "#/new"],
  ["new-details", "#/new", "details"],
  ["invoices", "#/invoices"],
  ["invoices-open", "#/invoices?filter=open"],
  ["invoice-open", `#/invoices/${open.id}`],
  ...(paid ? [["invoice-paid", `#/invoices/${paid.id}`]] : []),
  ["approvals", "#/approvals"],
  ["audit", "#/audit"],
  ["settings", "#/settings"],
  ["customer-page", `#/pay/${token}`],
];
const VARIANTS = [
  { name: "light, English", widths: WIDTHS, lang: "en", theme: "light" },
  { name: "dark, English", widths: [375, 1440], lang: "en", theme: "dark" },
  { name: "light, German", widths: [375, 1440], lang: "de", theme: "light" },
  { name: "compact", widths: [375, 1024], lang: "en", theme: "light", density: "compact" },
  { name: "reduced motion", widths: [375, 1440], lang: "en", theme: "light", reduced: true },
];

// ------------------------------------------------------------------ Chrome over its debugging port
const profile = join(tmpdir(), `paidloop-walk-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
const cleanup = () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows may keep the folder for a moment */
  }
};
process.on("exit", cleanup);

let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  } catch {
    await sleep(200);
  }
}
if (!target) throw new Error("Chrome did not start");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 0;
const waiting = new Map();
const listeners = [];
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) {
    const { resolve, reject } = waiting.get(data.id);
    waiting.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  } else if (data.method) listeners.forEach((fn) => fn(data));
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};

let errors = [];
listeners.push((event) => {
  if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") errors.push(event.params.args.map((a) => a.value || a.description).join(" "));
  if (event.method === "Log.entryAdded" && event.params.entry.level === "error") errors.push(`${event.params.entry.text} ${event.params.entry.url || ""}`);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");

// ------------------------------------------------------------------ the checks run inside the page
const PAGE_CHECKS = `(async () => {
  const out = {};
  const root = document.documentElement;
  out.overflow = root.scrollWidth - window.innerWidth;
  out.h1 = document.querySelectorAll("h1").length;
  out.mainText = (document.querySelector("main, .paypage")?.innerText || "").trim().length;
  out.stillLoading = !!document.querySelector(".loader-body, [aria-busy='true'].loading");
  out.lang = root.lang;
  out.theme = root.getAttribute("data-theme");
  const small = [];
  if (window.innerWidth < 768) {
    for (const el of document.querySelectorAll("button, input:not([type=hidden]):not([type=checkbox]), select, textarea, .button, .topbar nav a, .filter")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || el.closest("[hidden]") || el.classList.contains("sr-only")) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (box.height < 39.5) small.push((el.className || el.tagName) + ":" + Math.round(box.height) + " " + (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24));
    }
  }
  out.small = small.slice(0, 6);
  out.smallCount = small.length;
  const clipped = [];
  for (const el of document.querySelectorAll("main *, .paypage *")) {
    const box = el.getBoundingClientRect();
    // The hidden header row of a card list is clipped to 1px, so it can't be seen past the edge
    if (box.width && box.right > window.innerWidth + 1 && !el.closest(".sr-only, .rtable thead")) clipped.push(el.tagName + "." + String(el.className).slice(0, 24));
  }
  out.clipped = [...new Set(clipped)].slice(0, 5);
  ${axeSource}
  const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
  out.axe = result.violations.map((v) => v.id + " (" + v.nodes.length + "): " + v.nodes[0].target.join(" ") + " | " + (v.nodes[0].failureSummary || "").split("\\n")[1]);
  return out;
})()`;

let scriptId;
const rows = [];
const failures = [];

for (const variant of VARIANTS) {
  for (const width of variant.widths) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: width < 768 });
    await send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: variant.reduced ? "reduce" : "no-preference" }] });
    if (scriptId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
    // Only on the app's own address: the blank page between screens has no storage
    const setup = `if (location.protocol === "http:") { localStorage.setItem("paidloop.language","${variant.lang}");localStorage.setItem("paidloop.theme","${variant.theme}");localStorage.setItem("paidloop.density","${variant.density || "comfortable"}");sessionStorage.clear(); }`;
    scriptId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: setup })).identifier;

    for (const [name, hash, step] of ROUTES) {
      errors = [];
      await send("Page.navigate", { url: "about:blank" });
      await sleep(80);
      await send("Page.navigate", { url: `${BASE}/${hash}` });
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(150);
        try {
          ready = await evaluate(`!!document.querySelector("h1") && !document.querySelector(".loader-body")`);
        } catch {
          /* page still navigating */
        }
      }
      if (step === "details") {
        await evaluate(`[...document.querySelectorAll("button")].find((b) => /By hand|Von Hand/.test(b.textContent))?.click()`);
        await sleep(300);
      }
      await sleep(250);
      let result;
      try {
        result = await evaluate(PAGE_CHECKS);
      } catch (error) {
        result = { crashed: String(error.message).slice(0, 120) };
      }
      const problems = [];
      if (result.crashed) problems.push(`checks crashed: ${result.crashed}`);
      else {
        if (!ready) problems.push("page never finished loading");
        if (result.overflow > 0) problems.push(`sideways scroll of ${result.overflow}px`);
        if (result.clipped.length) problems.push(`content past the right edge: ${result.clipped.join(", ")}`);
        if (result.h1 !== 1) problems.push(`${result.h1} h1 elements`);
        if (result.mainText < 20) problems.push("page looks empty");
        if (result.lang !== variant.lang && name !== "customer-page") problems.push(`html lang is "${result.lang}", expected "${variant.lang}"`);
        if (result.theme !== variant.theme) problems.push(`theme is ${result.theme}, expected ${variant.theme}`);
        if (result.smallCount) problems.push(`${result.smallCount} touch targets under 40px, e.g. ${result.small.slice(0, 3).join("; ")}`);
        for (const violation of result.axe) problems.push(`axe ${violation}`);
      }
      for (const error of [...new Set(errors)]) problems.push(`console error: ${String(error).slice(0, 140)}`);

      if (SHOTS && ["home", "invoices", "invoice-open", "new-details", "customer-page"].includes(name) && [375, 1440].includes(width)) {
        mkdirSync(SHOTS, { recursive: true });
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(SHOTS, `${variant.name.replace(/\W+/g, "_")}_${width}_${name}.png`), Buffer.from(shot.data, "base64"));
      }
      rows.push({ variant: variant.name, width, name, ok: problems.length === 0 });
      if (problems.length) failures.push({ where: `${variant.name} @ ${width}px  ${name}`, problems });
      process.stdout.write(problems.length ? "x" : ".");
    }
  }
}
process.stdout.write("\n");

const total = rows.length;
const bad = rows.filter((row) => !row.ok).length;
console.log(`\nWalked ${total} screens (${ROUTES.length} routes x widths x variants): ${total - bad} clean, ${bad} with problems`);
for (const failure of failures) {
  console.log(`\n${failure.where}`);
  for (const problem of failure.problems) console.log(`   - ${problem}`);
}
cleanup();
process.exit(bad ? 1 : 0);
