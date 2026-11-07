// Measures the main screens with many invoices, with and without the indexes. Uses a temporary database.
//
// Run:  npm run benchmark -- [number of invoices]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { NoAI } from "../src/ai";
import { createApp } from "../src/app";
import { addDays } from "../src/dates";
import { Db } from "../src/db";
import { SimulatedPayPal } from "../src/paypal";
import { TABLES } from "../src/schema";
import { loadSettings } from "../src/settings";

const COUNT = Number(process.argv[2] ?? 20000);
const CUSTOMERS = Math.max(Math.floor(COUNT / 20), 10);
const TODAY = "2026-11-07";
// A firm with many old invoices: nearly all are closed, about 2 in 100 are still open.
const STATUSES = [...Array(965).fill("paid"), ...Array(13).fill("cancelled"), ...Array(15).fill("issued"), ...Array(3).fill("on_plan"), ...Array(2).fill("disputed"), ...Array(2).fill("draft")];
const ROUTES: Record<string, string> = {
  "Home screen": "/api/dashboard",
  "Invoice list, newest": "/api/invoices",
  "Invoice list, page 200": "/api/invoices?page=200",
  "Filter: overdue": "/api/invoices?filter=overdue",
  "Filter: paid, sorted by amount": "/api/invoices?filter=paid&sort=amount",
  "All, sorted by due date": "/api/invoices?sort=due",
  "All, sorted by customer": "/api/invoices?sort=customer",
  "Search by customer": "/api/invoices?q=kunde%20123",
  "Search by number": "/api/invoices?q=RE-2026-0012345",
  "Approvals": "/api/approvals",
  "Audit list": "/api/audit?limit=50",
};

/** A small repeatable random number source, so every run fills the same data. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function fill(db: Db): void {
  const rnd = random(7);
  const between = (low: number, high: number): number => low + Math.floor(rnd() * (high - low + 1));
  db.transaction(() => {
    for (let i = 1; i <= CUSTOMERS; i++) {
      db.insert("customer", { id: i, name: `Kunde ${i} GmbH`, name_key: `kunde ${i} gmbh`, street: "Weg 1", postcode: "32756", city: "Detmold", email: `k${i}@example.com` });
    }
    for (let i = 1; i <= COUNT; i++) {
      const status = STATUSES[between(0, STATUSES.length - 1)];
      const due = addDays(TODAY, -between(-30, 700));
      const gross = between(5000, 500000);
      db.insert("invoice", {
        id: i, customer_id: between(1, CUSTOMERS), number: status === "draft" ? null : `RE-2026-${String(i).padStart(7, "0")}`, status,
        issue_date: addDays(due, -14), due_date: due, service_date: addDays(due, -15),
        gross_cents: gross, net_cents: gross - Math.floor(gross / 6), vat_cents: Math.floor(gross / 6), paid_cents: status === "paid" ? gross : 0,
        paid_on: status === "paid" ? addDays(due, between(-5, 30)) : null, public_token: `tok${String(i).padStart(30, "0")}`,
      });
      if (status === "on_plan") {
        db.insert("payment_plan", { id: i, invoice_id: i, status: "active", created_by: "agent" });
        db.insert("installment", { plan_id: i, seq: 1, amount_cents: Math.floor(gross / 2), due_date: due });
        db.insert("installment", { plan_id: i, seq: 2, amount_cents: gross - Math.floor(gross / 2), due_date: addDays(due, 30) });
      }
      if (status === "issued" && i % 5 === 0) {
        db.insert("proposal", { invoice_id: i, action: "firm_reminder", reason: "late", reason_de: "spät", subject: "s", body: "b", payload: "{}" });
      }
      db.insert("audit_event", { id: i, at: "2026-11-07T10:00:00+00:00", actor: "rules", action: "checked", invoice_id: i, data: "{}", prev_hash: "0".repeat(64), hash: String(i).padStart(64, "0") });
    }
  });
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function measure(http: ReturnType<typeof request>): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  for (const [label, route] of Object.entries(ROUTES)) {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const response = await http.get(route);
      times.push(performance.now() - started);
      if (response.status !== 200) throw new Error(`${route}: ${response.status} ${response.text.slice(0, 200)}`);
    }
    results[label] = median(times);
  }
  return results;
}

async function main(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "paidloop-bench-"));
  const settings = loadSettings({ DATABASE_URL: `sqlite:///${folder.replaceAll("\\", "/")}/bench.db`, SYNC_INTERVAL_SECONDS: "0" }, join(folder, "none.env"));
  const { app, services } = await createApp({ settings, paypal: new SimulatedPayPal(), ai: new NoAI() });
  const http = request(app.getHttpServer());
  console.log(`Filling ${COUNT} invoices for ${CUSTOMERS} customers...`);
  fill(services.db);
  services.db.raw.exec("ANALYZE");
  const withIndexes = await measure(http);

  for (const table of Object.values(TABLES)) for (const name of Object.keys(table.indexes)) services.db.raw.exec(`DROP INDEX IF EXISTS "${name}"`);
  services.db.raw.exec("ANALYZE");
  const without = await measure(http);

  console.log(`\nMedian of 5 requests, ${COUNT} invoices, this laptop. Times in milliseconds.\n`);
  console.log(`| ${"Screen".padEnd(32)} | ${"With indexes".padStart(12)} | ${"Without".padStart(9)} |`);
  console.log(`|${"-".repeat(34)}|${"-".repeat(14)}|${"-".repeat(11)}|`);
  for (const label of Object.keys(ROUTES)) {
    console.log(`| ${label.padEnd(32)} | ${withIndexes[label].toFixed(1).padStart(12)} | ${without[label].toFixed(1).padStart(9)} |`);
  }
  await app.close();
  services.db.close();
}

void main();
