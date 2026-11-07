import { describe, expect, it } from "vitest";
import * as dashboard from "../src/dashboard";
import { Db } from "../src/db";
import * as demo from "../src/demo";
import * as invoices from "../src/invoices";
import * as ledger from "../src/ledger";
import { SimulatedPayPal } from "../src/paypal";
import { getInvoice } from "../src/repo";
import * as audit from "../src/audit";
import { addCustomer, jump, makeIssued, newPaypal, testDb } from "./fixtures";

describe("dashboard", () => {
  it("spendable money excludes VAT", async () => {
    const db = testDb(); const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!);
    await invoices.sync(db, invoice, paypal);
    const view = dashboard.build(db);
    expect(view.cash_cents).toBe(45220);
    expect(view.vat_due_cents).toBe(7220);
    expect(view.spendable_cents).toBe(38000);
    expect(view.ledger_balanced).toBe(true);
  });

  it("VAT on unpaid invoices is shown for Soll", async () => {
    const db = testDb();
    await makeIssued(db, newPaypal());
    const view = dashboard.build(db);
    expect(view.cash_cents).toBe(0);
    expect(view.vat_on_unpaid_cents).toBe(7220);
    expect(view.spendable_cents).toBe(-7220);
  });

  it("the forecast uses customer behaviour", async () => {
    const db = testDb(); const paypal = newPaypal();
    await makeIssued(db, paypal, { customer: addCustomer(db, "Treu GmbH", { history_paid_count: 8, history_avg_days_late: 1 }) });
    await makeIssued(db, paypal, { customer: addCustomer(db, "Spät UG", { history_paid_count: 6, history_avg_days_late: 30, history_unpaid_count: 2 }) });
    const view = dashboard.build(db);
    expect(view.forecast.at_risk).toBe(45220);
    expect(view.forecast.month).toBe(45220);
    expect(view.open_count).toBe(2);
  });

  it("overdue totals follow the clock", async () => {
    const db = testDb();
    await makeIssued(db, newPaypal());
    expect(dashboard.build(db).overdue_cents).toBe(0);
    jump(db, 15);
    expect(dashboard.build(db).overdue_cents).toBe(45220);
  });

  it("the work queue puts approvals first and shows drafts", async () => {
    const db = testDb(); const paypal = newPaypal();
    await makeIssued(db, paypal);
    jump(db, 20);
    const view = dashboard.build(db);
    expect(view.queue[0].kind).toBe("no_reminder_yet");
    expect(view.aging.days_1_30).toBe(45220);
  });

  it("rounds like the earlier version (halves to even)", () => {
    expect(dashboard.roundHalfEven(12.5)).toBe(12);
    expect(dashboard.roundHalfEven(13.5)).toBe(14);
    expect(dashboard.roundHalfEven(2.25, 1)).toBe(2.2);
    expect(dashboard.roundHalfEven(7.333, 1)).toBe(7.3);
  });
});

describe("two payment checks at once", () => {
  it("count a payment once", async () => {
    const db: Db = testDb();
    const paypal = new SimulatedPayPal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!);
    // Both checks ask PayPal before either one saves anything.
    let asked = 0;
    let release: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const realGet = paypal.get.bind(paypal);
    paypal.get = async (id: string) => {
      const state = await realGet(id);
      if (++asked === 2) release();
      await both;
      return state;
    };
    const copies = [getInvoice(db, invoice.id)!, getInvoice(db, invoice.id)!];
    await Promise.all(copies.map((copy) => invoices.sync(db, copy, paypal)));
    const stored = getInvoice(db, invoice.id)!;
    expect([stored.status, stored.paid_cents]).toEqual(["paid", invoice.gross_cents]);
    expect(db.scalar("SELECT COUNT(*) FROM payment WHERE invoice_id = ?", invoice.id)).toBe(1);
    expect(ledger.balance(db, ledger.CASH)).toBe(invoice.gross_cents);
    expect(audit.verify(db).ok).toBe(true);
  });
});

describe("demo data", () => {
  it("one click creates the story: one paid, three open", async () => {
    const db = testDb();
    await demo.reset(db, new SimulatedPayPal(), "");
    const view = dashboard.build(db);
    expect(view.paid_count).toBe(1);
    expect(view.open_count).toBe(3);
    expect(view.ledger_balanced).toBe(true);
    expect(audit.verify(db).ok).toBe(true);
    // doing it twice starts clean
    await demo.reset(db, new SimulatedPayPal(), "");
    expect(dashboard.build(db).open_count).toBe(3);
    expect(db.scalar("SELECT COUNT(*) FROM customer")).toBe(4);
  });
});
