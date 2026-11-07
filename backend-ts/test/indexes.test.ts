// Stored data must be found through indexes, and screens must not run one query per row.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import { Db } from "../src/db";
import { Api, createIssued, makeApi } from "./api";

const dirs = () => mkdtempSync(join(tmpdir(), "paidloop-idx-"));
const urlOf = (dir: string, name: string): string => `sqlite:///${dir.replaceAll("\\", "/")}/${name}`;

function planOf(db: Db, sql: string): string {
  return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail).join(" | ");
}

function indexDb(): Db {
  const db = new Db(urlOf(dirs(), "index.db"));
  db.prepare();
  return db;
}

describe("queries use their index", () => {
  const cases: [string, string][] = [
    ["SELECT id FROM invoice WHERE status = 'issued' ORDER BY id DESC LIMIT 25", "ix_invoice_status_id"],
    ["SELECT id FROM invoice WHERE status = 'issued' AND due_date < '2026-01-01'", "ix_invoice_status_due"],
    ["SELECT id FROM invoice ORDER BY due_date DESC LIMIT 25", "ix_invoice_due"],
    ["SELECT id FROM invoice ORDER BY gross_cents DESC LIMIT 25", "ix_invoice_gross"],
    ["SELECT status, count(id) FROM invoice GROUP BY status", "ix_invoice_status"],
    ["SELECT id FROM invoice WHERE customer_id = 1 ORDER BY id DESC", "ix_invoice_customer"],
    ["SELECT id FROM invoice WHERE paypal_id = 'x'", "ix_invoice_paypal_id"],
    ["SELECT id FROM invoice WHERE public_token = 'x'", "sqlite_autoindex_invoice"],
    ["SELECT id FROM invoice_line WHERE invoice_id = 1 ORDER BY position", "ix_invoice_line_invoice"],
    ["SELECT id FROM payment WHERE invoice_id = 1", "ix_payment_invoice"],
    ["SELECT id FROM payment_plan WHERE invoice_id = 1 AND status = 'active'", "ix_plan_invoice_status"],
    ["SELECT id FROM installment WHERE plan_id = 1 ORDER BY seq", "ix_installment_plan"],
    ["SELECT id FROM installment WHERE paypal_id = 'x'", "ix_installment_paypal_id"],
    ["SELECT id FROM proposal WHERE status = 'pending' ORDER BY id", "ix_proposal_status_id"],
    ["SELECT id FROM proposal WHERE invoice_id = 1 AND status = 'pending'", "ix_proposal_invoice_status"],
    ["SELECT count(id) FROM chat_message WHERE invoice_id = 1 AND role = 'customer' AND created_at >= '2026-01-01'", "ix_chat_invoice_role_time"],
    ["SELECT id FROM chat_message WHERE invoice_id = 1 ORDER BY id", "ix_chat_invoice_id"],
    ["SELECT id FROM journal_entry WHERE invoice_id = 1", "ix_journal_entry_invoice"],
    ["SELECT id FROM journal_line WHERE entry_id = 1", "ix_journal_line_entry"],
    ["SELECT sum(debit_cents), sum(credit_cents) FROM journal_line WHERE account = 'cash'", "ix_journal_line_account"],
    ["SELECT id FROM audit_event WHERE invoice_id = 1 AND id < 100 ORDER BY id DESC LIMIT 50", "ix_audit_invoice_id"],
    ["SELECT id FROM customer WHERE name_key = 'x'", "ix_customer_name_key"],
    ["SELECT id FROM customer ORDER BY name_key LIMIT 50", "ix_customer_name_key"],
  ];
  const db = indexDb();
  it.each(cases)("%s", (sql, expected) => {
    const plan = planOf(db, sql);
    expect(plan, plan).toContain(expected);
  });

  it("the results on Home are read from the index alone", () => {
    const plan = planOf(db, "SELECT count(id), avg(julianday(paid_on) - julianday(issue_date)), sum(CASE WHEN paid_on <= due_date THEN 1 ELSE 0 END) FROM invoice WHERE status = 'paid'");
    const timed = planOf(db, "SELECT avg(seconds_to_issue), count(seconds_to_issue) FROM invoice WHERE seconds_to_issue IS NOT NULL");
    expect(plan).toContain("COVERING INDEX ix_invoice_paid_results");
    expect(timed).toContain("COVERING INDEX ix_invoice_timed");
  });

  it("search is a prefix range on an index", () => {
    const byName = planOf(db, "SELECT id FROM customer WHERE name_key >= 'kun' AND name_key < 'kun' || char(1114111)");
    const byNumber = planOf(db, "SELECT id FROM invoice WHERE number >= 'RE-2026-001' AND number < 'RE-2026-001' || char(1114111)");
    const inside = planOf(db, "SELECT id FROM customer WHERE name_key LIKE '%kun%'");
    expect(byName).toContain("SEARCH");
    expect(byName).toContain("ix_customer_name_key");
    expect(byNumber).toContain("SEARCH");
    expect(inside).toContain("SCAN"); // what the old search did
  });

  it("the exact list query from the screen uses an index for every filter and sort", () => {
    const filters = [
      "invoice.status IN ('issued','on_plan','disputed')",
      "invoice.status = 'paid'",
      "(invoice.number >= 'RE' AND invoice.number < 'RE' || char(1114111))",
    ];
    for (const where of filters) {
      const plan = planOf(db, `SELECT id FROM invoice WHERE ${where} ORDER BY invoice.id DESC LIMIT 25 OFFSET 0`);
      expect(plan, where).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|SEARCH/);
    }
  });

  it("balances are read from the index alone", () => {
    expect(planOf(db, "SELECT sum(debit_cents), sum(credit_cents) FROM journal_line WHERE account = 'cash'")).toContain("COVERING INDEX");
  });
});

describe("old databases", () => {
  it("an old database gets new columns, indexes and search keys", () => {
    const url = urlOf(dirs(), "old.db");
    const db = new Db(url);
    db.prepare();
    db.raw.exec("INSERT INTO customer (name, name_key, street, postcode, city, country, email, is_business, language, history_paid_count, history_avg_days_late, history_unpaid_count) VALUES ('Alt  GmbH', '', '', '', '', 'DE', '', 1, 'de', 0, 0, 0)");
    db.raw.exec("DROP INDEX ix_invoice_status_id");
    db.raw.exec("DROP INDEX ix_customer_name_key");
    db.raw.exec("DROP INDEX ix_invoice_timed");
    db.raw.exec("ALTER TABLE invoice DROP COLUMN seconds_to_issue");
    db.raw.exec("ALTER TABLE proposal DROP COLUMN reason_de");

    db.prepare();

    const names = (sql: string): string[] => (db.raw.prepare(sql).all() as { name: string }[]).map((row) => row.name);
    expect(names("PRAGMA table_info(invoice)")).toContain("seconds_to_issue");
    expect(names("PRAGMA table_info(proposal)")).toContain("reason_de");
    expect(names("PRAGMA index_list(invoice)")).toEqual(expect.arrayContaining(["ix_invoice_status_id", "ix_invoice_timed"]));
    expect(names("PRAGMA index_list(customer)")).toContain("ix_customer_name_key");
    expect(db.scalar("SELECT name_key FROM customer")).toBe("alt gmbh");

    db.prepare(); // running it again must change nothing and must not fail
    db.close();
  });
});

// Real requests, counting the SQL they run

const apis: Api[] = [];
afterAll(async () => { for (const api of apis) await api.close(); });
async function client(): Promise<Api> {
  const api = await makeApi({ setup: false });
  apis.push(api);
  return api;
}

/** Many invoices with customers, plans and pending steps, written straight to the database. */
function fill(api: Api, count: number): void {
  const db = api.services.db;
  const today = "2026-11-07";
  db.transaction(() => {
    const customers = Array.from({ length: count }, (_, i) => db.insert("customer", { name: `Kunde ${i} GmbH`, name_key: `kunde ${i} gmbh`, email: `k${i}@example.com` }));
    for (let i = 0; i < count; i++) {
      const status = ["issued", "on_plan", "disputed", "paid", "draft"][i % 5];
      const id = db.insert("invoice", {
        customer_id: customers[i], status, number: status === "draft" ? null : `RE-2026-${String(i).padStart(5, "0")}`,
        issue_date: today, due_date: addDays(today, -((i % 40) - 10)), gross_cents: 10000 + i, net_cents: 8403, vat_cents: 1597 + i, paid_cents: 0,
        public_token: `token-${String(i).padStart(30, "0")}`,
      });
      if (status === "on_plan") {
        const plan = db.insert("payment_plan", { invoice_id: id, status: "active", created_by: "agent" });
        db.insert("installment", { plan_id: plan, seq: 1, amount_cents: 5000, due_date: addDays(today, -5) });
        db.insert("installment", { plan_id: plan, seq: 2, amount_cents: 5000 + i, due_date: addDays(today, 25) });
      }
      if (status === "issued") db.insert("proposal", { invoice_id: id, action: "firm_reminder", reason: "x", reason_de: "y", subject: "s", body: "b", payload: "{}" });
    }
  });
}

function countQueries(api: Api, call: () => Promise<{ status: number; text: string }>): Promise<number> {
  const seen: string[] = [];
  api.services.db.trace = (sql) => { if (sql.trimStart().toUpperCase().startsWith("SELECT")) seen.push(sql); };
  return call().then((response) => {
    expect(response.status, response.text).toBe(200);
    return seen.length;
  }).finally(() => { api.services.db.trace = null; });
}

describe("screens do not run one query per row", () => {
  it.each(["/api/invoices?size=100", "/api/invoices?filter=overdue&size=100", "/api/dashboard", "/api/approvals"])("%s", async (path) => {
    const api = await client();
    fill(api, 20);
    await api.get(path); // the very first call also creates the owner's empty business record
    const small = await countQueries(api, () => api.get(path));
    const db = api.services.db;
    for (const table of ["installment", "payment_plan", "proposal", "invoice", "customer"]) db.run(`DELETE FROM ${table}`);
    fill(api, 100);
    const large = await countQueries(api, () => api.get(path));
    expect(large, `${small} queries for 20 rows, ${large} queries for 100 rows`).toBe(small);
  });
});

describe("the invoice list", () => {
  it("pages, filters and counts", async () => {
    const api = await client();
    fill(api, 60);
    const first = (await api.get("/api/invoices?size=25")).body;
    expect(first.total).toBe(60);
    expect(first.items).toHaveLength(25);
    const second = (await api.get("/api/invoices?size=25&page=2")).body;
    const ids = new Set(first.items.map((row: { id: number }) => row.id));
    expect(second.items.some((row: { id: number }) => ids.has(row.id))).toBe(false);
    expect(first.counts).toEqual({ all: 60, open: 36, overdue: first.counts.overdue, on_plan: 12, disputed: 12, draft: 12, paid: 12, cancelled: 0 });
    for (const name of ["open", "on_plan", "disputed", "draft", "paid", "cancelled"]) {
      expect((await api.get(`/api/invoices?filter=${name}&size=100`)).body.total, name).toBe(first.counts[name]);
    }
    const overdue = (await api.get("/api/invoices?filter=overdue&size=100")).body;
    expect(overdue.total).toBe(first.counts.overdue);
    expect(overdue.total).toBeGreaterThan(0);
    expect(overdue.items.every((row: { days_overdue: number }) => row.days_overdue > 0)).toBe(true);
    // An unknown filter shows everything instead of failing.
    expect((await api.get("/api/invoices?filter=nonsense")).body.total).toBe(60);
  });

  it("search finds the number and the customer and treats wildcards as text", async () => {
    const api = await client();
    fill(api, 30);
    expect((await api.get("/api/invoices?q=RE-2026-00011")).body.total).toBe(1);
    expect((await api.get("/api/invoices?q=re-2026-0001")).body.total).toBe(8); // lower case works; 00010 to 00019 minus two drafts, which have no number
    const byName = (await api.get("/api/invoices?q=" + encodeURIComponent("kunde 7 gmbh"))).body;
    expect(byName.total).toBe(1);
    expect(byName.items[0].customer.name).toBe("Kunde 7 GmbH");
    expect((await api.get("/api/invoices?q=%25")).body.total).toBe(0);
    expect((await api.get("/api/invoices?q=_")).body.total).toBe(0);
  });

  it.each([
    ["amount", (row: any) => row.gross_cents],
    ["due", (row: any) => row.due_date],
    ["customer", (row: any) => row.customer.name.toLowerCase()],
  ])("sorting by %s works both ways", async (sort, key) => {
    const api = await client();
    fill(api, 25);
    const up = (await api.get(`/api/invoices?sort=${sort}&dir=asc&size=100`)).body.items.map(key);
    const down = (await api.get(`/api/invoices?sort=${sort}&dir=desc&size=100`)).body.items.map(key);
    expect(up).toEqual([...up].sort());
    expect(down).toEqual([...down].sort().reverse());
  });

  it("refuses impossible requests with a clear message", async () => {
    const api = await client();
    const response = await api.get("/api/invoices?size=100000", { "X-Language": "de" });
    expect(response.status).toBe(422);
    expect(response.body.detail).toBe("Bitte prüfen Sie Ihre Eingaben.");
    expect(response.body.fields).toEqual(["size"]);
    expect((await api.get("/api/invoices?sort=drop_table")).status).toBe(422);
  });

  it("does not read stored PDFs", async () => {
    const api = await client();
    fill(api, 5);
    api.services.db.run("UPDATE invoice SET pdf = zeroblob(5000000)");
    const seen: string[] = [];
    api.services.db.trace = (sql) => seen.push(sql);
    expect((await api.get("/api/invoices")).status).toBe(200);
    expect((await api.get("/api/dashboard")).status).toBe(200);
    api.services.db.trace = null;
    expect(seen.filter((sql) => /"pdf"|invoice\.pdf/.test(sql))).toEqual([]);
  });
});

describe("other lists", () => {
  it("the audit list continues from the last row and verifies separately", async () => {
    const api = await client();
    await api.post("/api/demo/reset");
    const first = (await api.get("/api/audit?limit=5")).body;
    expect(first.events).toHaveLength(5);
    expect(first.next_before_id).toBe(first.events.at(-1).id);
    const second = (await api.get(`/api/audit?limit=5&before_id=${first.next_before_id}`)).body;
    expect(second.events[0].id).toBeLessThan(first.events.at(-1).id);
    expect(first).not.toHaveProperty("chain");
    expect((await api.get("/api/audit/verify")).body.ok).toBe(true);
  }, 60000);

  it("the same customer typed twice is one customer", async () => {
    const api = await client();
    const one = (await api.post("/api/customers", { name: "Bäckerei  Muster GmbH", email: "a@example.com" })).body;
    const two = (await api.post("/api/customers", { name: "bäckerei muster gmbh", city: "Detmold", email: "A@example.com" })).body;
    expect(one.id).toBe(two.id);
    expect(two.city).toBe("Detmold");
    // The same name with a different email can be a different firm, so it stays separate.
    const other = (await api.post("/api/customers", { name: "Bäckerei Muster GmbH", email: "b@example.com" })).body;
    expect(other.id).not.toBe(one.id);
    expect((await api.get("/api/customers?q=" + encodeURIComponent("bäckerei"))).body).toHaveLength(2);
    expect((await api.get("/api/customers?q=muster")).body).toEqual([]); // search is by the start of the name
    expect((await api.get("/api/customers?q=%25")).body).toEqual([]);
  });

  it("a draft can be deleted but an issued invoice cannot", async () => {
    const api = await client();
    await api.post("/api/demo/reset");
    const customer = (await api.post("/api/customers", { name: "Weg GmbH", street: "Weg 1", postcode: "32756", city: "Detmold", email: "w@example.com" })).body;
    const lines = [{ description: "Arbeit", quantity: 1, unit: "H87", unit_price_eur: 100, vat_percent: 19 }];
    const draft = (await api.post("/api/invoices", { customer_id: customer.id, service_date: "2026-11-01", due_date: "2026-11-20", lines })).body;
    expect((await api.post(`/api/invoices/${draft.id}/check`)).body.can_issue).toBe(true);
    const keep = (await api.post(`/api/invoices/${draft.id}/issue`, { seconds_to_issue: 42 })).body;
    const refused = await api.delete(`/api/invoices/${keep.id}`, { "X-Language": "de" });
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toContain("Entwürfe");
    expect((await api.get("/api/dashboard")).body.performance.avg_seconds_to_issue).toBe(42);

    const second = (await api.post("/api/invoices", { customer_id: customer.id, lines })).body;
    expect((await api.delete(`/api/invoices/${second.id}`)).body.status).toBe("deleted");
    expect((await api.get(`/api/invoices/${second.id}`)).status).toBe(404);
    expect((await api.get("/api/audit/verify")).body.ok).toBe(true);
  }, 60000);

  it("Home shows measured results and a work queue", async () => {
    const api = await client();
    await api.post("/api/demo/reset");
    await api.post("/api/demo/jump", { days: 16 });
    let view = (await api.get("/api/dashboard")).body;
    expect(Object.values(view.aging as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(view.open_cents);
    expect(view.performance.paid_count).toBeGreaterThanOrEqual(1);
    expect(view.queue.map((item: { kind: string }) => item.kind)).toContain("no_reminder_yet");
    for (const item of view.queue) for (const key of ["kind", "invoice_id", "amount_cents", "customer"]) expect(item).toHaveProperty(key);
    await api.post("/api/agent/run");
    await api.post("/api/demo/jump", { days: 8 });
    await api.post("/api/agent/run");
    view = (await api.get("/api/dashboard")).body;
    const approvals = view.queue.filter((item: { kind: string }) => item.kind === "approval");
    expect(approvals.length).toBeGreaterThan(0);
    expect(view.queue[0].kind).toBe("approval");
    expect((await api.get("/api/health")).body.pending_approvals).toBe(approvals.length);
  }, 90000);
});

void createIssued;
