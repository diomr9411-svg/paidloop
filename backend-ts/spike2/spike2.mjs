// Spike 2: free offline OCR, SQLite with indexes, and a local Ollama call from TypeScript/Node.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, gte, lt, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const log = (name, ok, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);

// ---- 1. OCR with language files from npm (no download at run time)
const langDir = dirname(require.resolve("@tesseract.js-data/deu/package.json"));
const deuPath = join(langDir, "4.0.0_best_int");
const engPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
const started = Date.now();
const worker = await createWorker("deu", 1, { langPath: deuPath, gzip: true, cacheMethod: "none" });
const { data } = await worker.recognize(readFileSync(new URL("./note.png", import.meta.url)));
await worker.terminate();
const wanted = ["Montage", "Küche", "Müller", "3,5", "60", "05.11.2026"];
const found = wanted.filter((w) => data.text.includes(w));
log("OCR reads a German note", found.length >= 5, `${found.length}/${wanted.length} words, ${Date.now() - started} ms\n     ${data.text.trim().replaceAll("\n", " | ")}`);

// ---- 2. SQLite + Drizzle + indexes + WAL
const invoices = sqliteTable("invoice", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull(),
  status: text("status").notNull(),
  customer: text("customer").notNull(),
  gross: integer("gross").notNull(),
}, (t) => [index("ix_invoice_number").on(t.number), index("ix_invoice_status_id").on(t.status, t.id)]);

const raw = new Database(":memory:");
raw.pragma("journal_mode = WAL");
raw.exec(`CREATE TABLE invoice (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL, status TEXT NOT NULL, customer TEXT NOT NULL, gross INTEGER NOT NULL);
CREATE INDEX ix_invoice_number ON invoice(number); CREATE INDEX ix_invoice_status_id ON invoice(status, id);`);
const db = drizzle(raw);
const insert = raw.prepare("INSERT INTO invoice (number, status, customer, gross) VALUES (?,?,?,?)");
raw.transaction(() => { for (let i = 1; i <= 20000; i++) insert.run(`RE-2026-${String(i).padStart(4, "0")}`, i % 3 ? "issued" : "paid", `Kunde ${i % 500}`, i * 100); })();

const prefix = "RE-2026-00";
const t0 = performance.now();
const rows = db.select().from(invoices).where(and(gte(invoices.number, prefix), lt(invoices.number, prefix + "\u{10ffff}"))).limit(25).all();
const ms = performance.now() - t0;
const query = db.select().from(invoices).where(and(gte(invoices.number, prefix), lt(invoices.number, prefix + "\u{10ffff}"))).limit(25).toSQL();
const plan = raw.prepare("EXPLAIN QUERY PLAN " + query.sql).all(...query.params).map((r) => r.detail).join(" ; ");
log("prefix search uses the index", /USING INDEX ix_invoice_number/.test(plan), `${rows.length} rows in ${ms.toFixed(1)} ms; plan: ${plan}`);
const count = db.select({ n: sql`count(*)` }).from(invoices).where(sql`status = 'paid'`).get();
log("aggregate query on 20,000 rows", count.n > 6000, `paid = ${count.n}`);

// ---- 3. Ollama over HTTP (plain fetch; no extra library)
try {
  const tags = await (await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) })).json();
  log("Ollama is reachable", true, `models: ${tags.models.map((m) => m.name).join(", ") || "none pulled yet"}`);
} catch (error) {
  log("Ollama is reachable", false, `(${error.message}) - the app must fall back to fixed rules, same as the Python version`);
}
