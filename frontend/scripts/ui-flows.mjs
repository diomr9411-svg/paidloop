// Uses the real screens like an owner would, in headless Chrome, and checks the main flows end to end:
// a note becomes an issued invoice, a bank payment is recorded, an invoice is cancelled through the confirm
// dialog, a settings card saves itself, the customer chat answers, the phone menu works by keyboard only, and a
// photo of a note is shown beside the fields read from it.
// It CHANGES the data (issues and cancels invoices), so run it on fresh demo data: CI does, after the walk.
// Run: npm run flows   (UI_URL=http://127.0.0.1:8000 by default; CHROME_PATH if Chrome is elsewhere)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.UI_URL || "http://127.0.0.1:8000";
const CHROME = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(
  (path) => path && existsSync(path),
);
if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");
const PORT = 9800 + Math.floor(Math.random() * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), `paidloop-e2e-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
process.on("exit", () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows may keep the folder for a moment */
  }
});

let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  } catch {
    await sleep(200);
  }
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
let nextId = 0;
const waiting = new Map();
const errors = [];
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) {
    const { resolve, reject } = waiting.get(data.id);
    waiting.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  } else if (data.method === "Runtime.exceptionThrown") errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
  else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") errors.push(data.params.args.map((a) => a.value || a.description).join(" "));
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};
await send("Page.enable");
await send("Runtime.enable");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
async function until(expression, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await js(expression)) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}
const go = async (hash) => {
  await send("Page.navigate", { url: `${BASE}/?e2e=${Date.now()}${hash}` });
  await until(`!!document.querySelector("h1") && !document.querySelector(".loader-body")`);
};
const clickText = (selector, pattern) =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${pattern}.test(e.textContent)); if (!el) return false; el.click(); return true; })()`);
const key = async (keyName, code) => {
  const text = keyName === "Enter" ? String.fromCharCode(13) : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text, unmodifiedText: text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: keyName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};
const toastSays = (pattern) => until(`[...document.querySelectorAll(".toast")].some((t) => ${pattern}.test(t.textContent))`, 15000);

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (location.protocol === "http:") { localStorage.setItem("paidloop.language","en"); localStorage.setItem("paidloop.theme","light"); }` });

// 1. A note becomes an issued invoice
await go("#/new");
await clickText("button", /Use an example/);
check("Use an example fills the note box", await until(`document.getElementById("job-note").value.includes("Muster")`));
await clickText("button", /Read note/);
check("Read note opens the details step", await until(`!!document.getElementById("details-title")`, 30000));
check("known customer recognised from the note", await js(`/Muster/.test(document.querySelector(".known")?.textContent || "")`), await js(`document.querySelector(".known strong")?.textContent || "no known-customer card"`));
check("one header row for the items (desktop)", await js(`getComputedStyle(document.querySelector(".lines-head")).display === "grid"`));
await clickText("button", /Check invoice/);
check("Check invoice opens the check step", await until(`!!document.getElementById("check-title")`, 30000));
const canIssue = await js(`!![...document.querySelectorAll("button")].find((b) => /Issue invoice/.test(b.textContent))`);
if (!canIssue) {
  const issues = await js(`[...document.querySelectorAll(".issue")].map((i) => i.textContent).join(" | ")`);
  check("invoice can be issued", false, issues.slice(0, 300));
} else {
  await clickText("button", /Issue invoice/);
  check("Issue invoice ends on the done step", await until(`!!document.getElementById("done-title")`, 45000), await js(`document.getElementById("done-title")?.textContent || ""`));
}

// 2. The new invoice page shows the invoice face; a bank payment is recorded
await clickText("a", /Open invoice/);
check("invoice page shows the invoice face", await until(`!!document.querySelector(".paper .paper-number")`));
await js(`document.getElementById("bank-payment").focus()`);
await send("Input.insertText", { text: "50" });
await clickText("button", /Record payment/);
check("bank payment recorded (toast)", await toastSays(/payment is recorded/i));
check("payment listed on the invoice face", await until(`/Payments received/i.test(document.querySelector(".paper")?.textContent || "")`));

// 3. Cancel an unpaid invoice through the one confirm dialog
const list = await (await fetch(`${BASE}/api/invoices?size=100`)).json();
const unpaid = list.items.find((row) => row.status === "issued" && row.paid_cents === 0);
await go(`#/invoices/${unpaid.id}`);
await clickText("button", /^Cancel invoice$/);
check("confirm dialog opens", await until(`!!document.querySelector("dialog.dialog[open]")`));
check("focus is inside the dialog, not on the dangerous button", await js(`(() => { const d = document.querySelector("dialog.dialog[open]"); const a = document.activeElement; return d.contains(a) && !/Yes, cancel/.test(a.textContent); })()`), await js(`document.activeElement?.textContent || ""`));
await clickText("dialog[open] button", /Yes, cancel this invoice/);
check("invoice cancelled (toast)", await toastSays(/invoice is cancelled/i));
check("dialog closed after confirming", await until(`!document.querySelector("dialog.dialog[open]")`));

// 4. Settings: each card saves itself
await go("#/settings");
await js(`document.getElementById("business-city").focus()`);
await send("Input.insertText", { text: " Ost" });
check("unsaved mark on the business card only", await until(`(() => { const forms = [...document.querySelectorAll("form")]; return /Unsaved changes/.test(forms[0].textContent) && !/Unsaved changes/.test(forms[1].textContent); })()`));
const limitSaveDisabled = await js(`[...document.querySelectorAll("form")][1].querySelector("button[type=submit]").disabled`);
check("the limits card's Save stays off", limitSaveDisabled);
await js(`[...document.querySelectorAll("form")][0].querySelector("button[type=submit]").click()`);
check("business card saved (toast)", await toastSays(/^\s*Saved\.?/));
check("unsaved mark gone after saving", await until(`!/Unsaved changes/.test(document.body.textContent)`));
const business = await (await fetch(`${BASE}/api/business`)).json();
check("saved city reached the server", /Ost$/.test(business.city), business.city);

// 5. Customer page: a suggestion gets an answer
const open = (await (await fetch(`${BASE}/api/invoices?size=100`)).json()).items.find((row) => row.status === "issued");
const token = (await (await fetch(`${BASE}/api/invoices/${open.id}`)).json()).public_token;
await go(`#/pay/${token}`);
const before = await js(`document.querySelectorAll(".bubble").length`);
await clickText("button", /more time|mehr Zeit/i);
check("customer chat answers", await until(`document.querySelectorAll(".bubble").length >= ${before + 2} && !document.querySelector(".bubble.thinking")`, 60000), `${await js(`document.querySelectorAll(".bubble").length`)} bubbles`);

// 6. Phone: the menu drawer by keyboard only
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
await go("#/");
await js(`document.querySelector(".menu-button").focus()`);
await key("Enter", 13);
check("menu drawer opens with Enter", await until(`!!document.querySelector("dialog.drawer[open]")`));
check("focus moves into the drawer", await js(`document.querySelector("dialog.drawer[open]").contains(document.activeElement)`));
await key("Escape", 27);
check("Escape closes the drawer", await until(`!document.querySelector("dialog.drawer[open]")`));
check("focus returns to the menu button", await until(`document.activeElement?.classList.contains("menu-button")`, 3000));

// 7. A photo of a note: the fields and the photo side by side on a desktop, one under the other on a phone.
// The picture is drawn in the page, so no file is needed. With a local vision model the reading takes a while.
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await go("#/new");
await js(`(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1000; canvas.height = 600;
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#ffffff"; pen.fillRect(0, 0, 1000, 600);
  pen.fillStyle = "#1d2a5c"; pen.font = "48px sans-serif";
  ["at Mueller GmbH", "2 hours at 60 euro", "valve 18,90 euro"].forEach((line, row) => pen.fillText(line, 60, 120 + row * 90));
  const picture = await new Promise((done) => canvas.toBlob(done, "image/png"));
  const files = new DataTransfer();
  files.items.add(new File([picture], "note.png", { type: "image/png" }));
  const input = document.querySelector("input[type=file]");
  input.files = files.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
check("a photo opens the details step", await until(`!!document.getElementById("details-title")`, 300000));
check("the photo is shown, with a badge saying it was read from a photo", await until(`document.querySelector(".photo-preview")?.naturalWidth > 0 && /Photo read/.test(document.querySelector(".card-head .badge")?.textContent || "")`));
check("photo beside the fields on a desktop", await js(`document.querySelector(".photo-preview").getBoundingClientRect().left > document.getElementById("details-title").closest(".card").getBoundingClientRect().right`));
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
check("photo under the fields on a phone, nothing sideways", await until(`document.querySelector(".photo-preview").getBoundingClientRect().top > document.getElementById("details-title").closest(".card").getBoundingClientRect().bottom && document.documentElement.scrollWidth <= innerWidth`, 3000));
// A sideways photo (WhatsApp drops the EXIF turn): Turn photo turns it at once, then it can be read again
await clickText("button", /Turn right/);
check("Turn right turns the photo and offers Read again", await until(`(() => { const img = document.querySelector(".photo-preview"); return img.naturalWidth > 0 && img.naturalWidth < img.naturalHeight && [...document.querySelectorAll("button")].some((b) => /Read again/.test(b.textContent)) && document.documentElement.scrollWidth <= innerWidth; })()`));
await clickText("button", /Turn left/);
check("Turn left turns it back", await until(`(() => { const img = document.querySelector(".photo-preview"); return img.naturalWidth > img.naturalHeight; })()`));

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
