import { describe, expect, it } from "vitest";
import { addDays, realToday } from "../src/dates";
import { Db } from "../src/db";
import * as einvoice from "../src/einvoice";
import * as invoices from "../src/invoices";
import { InvoiceError, LineInput } from "../src/invoices";
import * as ledger from "../src/ledger";
import { PayPalError, SimulatedPayPal } from "../src/paypal";
import { activePlan, businessOf, change, getInvoice, openCents, plansOf } from "../src/repo";
import { CHECKED, DRAFT, ISSUED, PAID } from "../src/states";
import { addCustomer, LINES, makeIssued, newPaypal, testDb } from "./fixtures";
import { memoryDb, pdfText } from "./helpers";

const draftFor = (db: Db, customerId: number, overrides: Partial<Parameters<typeof invoices.saveDraft>[2]> = {}) => {
  const on = invoices.today(db);
  return invoices.saveDraft(db, null, {
    customer_id: customerId, lines: LINES, issue_date: on, service_date: on, due_date: addDays(on, 14), property_work: false, ...overrides,
  });
};

describe("issuing", () => {
  it("creates the legal invoice, the PayPal request and the ledger entries", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    expect(invoice.status).toBe(ISSUED);
    expect(invoice.number!.endsWith("-0001")).toBe(true);
    expect(invoice.gross_cents).toBe(45220);
    const full = getInvoice(db, invoice.id, ["xml", "pdf"])!;
    expect((await einvoice.readBackXml(full.pdf!))!.equals(full.xml!)).toBe(true);
    expect((await einvoice.validateRules(full.xml!)).problems).toEqual([]);
    expect((await paypal.get(invoice.paypal_id!)).due_cents).toBe(45220);
    expect(ledger.balance(db, ledger.RECEIVABLE)).toBe(45220);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBe(7220);
    expect(invoice.public_token!.length).toBeGreaterThanOrEqual(30);
  });

  it("numbers have no gaps and a failure uses no number", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const first = await makeIssued(db, paypal);
    const draft = draftFor(db, addCustomer(db, "Zweite GmbH").id);
    invoices.runCheck(db, draft);
    paypal.failNext = new PayPalError("Sandbox is down", 503);
    await expect(invoices.issue(db, draft, paypal)).rejects.toBeInstanceOf(InvoiceError);
    expect(businessOf(db).next_number).toBe(2);
    const after = getInvoice(db, draft.id)!;
    expect(after.number).toBeNull();
    expect(after.status).toBe(CHECKED);
    expect(ledger.balance(db, ledger.RECEIVABLE)).toBe(first.gross_cents);

    await invoices.issue(db, draft, paypal);
    expect(first.number!.endsWith("-0001")).toBe(true);
    expect(draft.number!.endsWith("-0002")).toBe(true);
  });

  it("issuing needs a passed check", async () => {
    const db = testDb();
    const draft = draftFor(db, addCustomer(db).id);
    await expect(invoices.issue(db, draft, newPaypal())).rejects.toBeInstanceOf(InvoiceError);
  });

  it("the check blocks missing fields", () => {
    const db = testDb();
    const draft = draftFor(db, addCustomer(db).id, { service_date: null });
    const result = invoices.runCheck(db, draft);
    expect(result.can_issue).toBe(false);
    expect(draft.status).toBe(DRAFT);
    expect(result.issues.map((i) => i.rule_id)).toContain("R-14-6-SERVICE-DATE");
  });

  it("an issued invoice cannot be edited", async () => {
    const db = testDb();
    const invoice = await makeIssued(db, newPaypal());
    expect(() => invoices.saveDraft(db, invoice, { customer_id: invoice.customer_id, lines: LINES, issue_date: null, service_date: null, due_date: null, property_work: false })).toThrow(InvoiceError);
  });

  it("an amount mismatch at PayPal stops the issue and cancels the request", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const draft = draftFor(db, addCustomer(db).id);
    invoices.runCheck(db, draft);
    const original = paypal.get.bind(paypal);
    paypal.get = async (id: string) => ({ ...(await original(id)), due_cents: 1 });
    await expect(invoices.issue(db, draft, paypal)).rejects.toThrow("Nothing was issued");
    expect(getInvoice(db, draft.id)!.number).toBeNull();
    expect(paypal.calls).toContain("cancel");
  });

  it("a VAT rounding difference uses one line per rate", async () => {
    // Three lines at 0.03 EUR: per item VAT rounds to 1 cent each (3), per rate VAT on 0.09 rounds to 2.
    const lines: LineInput[] = [0, 1, 2].map((n) => ({ description: `Klein ${n}`, quantity_milli: 1000, unit: "H87", unit_price_cents: 3, vat_bp: 1900 }));
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal, { lines });
    expect(invoice.vat_cents).toBe(2);
    expect((await paypal.get(invoice.paypal_id!)).due_cents).toBe(11);
    expect(invoice.gross_cents).toBe(11);
  });

  it("invoices issued at the same time never get the same number", async () => {
    const db = testDb();
    const sim = new SimulatedPayPal();
    const drafts = [0, 1, 2, 3].map((n) => {
      const draft = draftFor(db, addCustomer(db, `K${n}`).id);
      invoices.runCheck(db, draft);
      return draft;
    });
    const results = await Promise.all(drafts.map((draft) => invoices.issue(db, draft, sim)));
    const numbers = results.map((invoice) => invoice.number!);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers.map((n) => Number(n.slice(-4))).sort()).toEqual([1, 2, 3, 4]);
  });

  it("a small business invoice with no VAT is issued", async () => {
    const db = testDb();
    const business = businessOf(db);
    change(db, "business", business, { small_business: true, vat_id: "", tax_number: "330/1234/5678" });
    const invoice = await makeIssued(db, newPaypal(), { lines: [{ description: "Arbeit", quantity_milli: 1000, unit: "HUR", unit_price_cents: 30000, vat_bp: 1900 }] });
    expect(invoice.vat_cents).toBe(0);
    expect(invoice.gross_cents).toBe(30000);
  });
});

describe("payments", () => {
  it("a partial then a full payment", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!, 10000);
    expect(await invoices.sync(db, invoice, paypal)).toBe(10000);
    expect(invoice.status).toBe(ISSUED);
    expect(openCents(invoice)).toBe(35220);
    paypal.pay(invoice.paypal_id!);
    await invoices.sync(db, invoice, paypal);
    expect(invoice.status).toBe(PAID);
    expect(openCents(invoice)).toBe(0);
    expect(ledger.balance(db, ledger.CASH)).toBe(45220);
    expect(ledger.balance(db, ledger.RECEIVABLE)).toBe(0);
  });

  it("the same payment seen twice counts once", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!, 10000);
    await invoices.sync(db, invoice, paypal);
    expect(await invoices.sync(db, invoice, paypal)).toBe(0);
    const state = await paypal.get(invoice.paypal_id!);
    expect(invoices.applyState(db, invoice, state)).toBe(0);
    expect(invoice.paid_cents).toBe(10000);
    expect(db.scalar("SELECT COUNT(*) FROM payment")).toBe(1);
  });

  it("two payment checks at once count a payment once", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!);
    const copies = [0, 1, 2].map(() => getInvoice(db, invoice.id)!);
    const results = await Promise.all(copies.map((copy) => invoices.sync(db, copy, paypal)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(45220);
    expect(db.scalar("SELECT COUNT(*) FROM payment")).toBe(1);
    expect(getInvoice(db, invoice.id)!.paid_cents).toBe(45220);
    expect(getInvoice(db, invoice.id)!.status).toBe(PAID);
  });

  it("a paid invoice stops pending approvals", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    const id = db.insert("proposal", { invoice_id: invoice.id, action: "firm_reminder", subject: "s", body: "b" });
    paypal.pay(invoice.paypal_id!);
    await invoices.sync(db, invoice, paypal);
    expect(db.get("proposal", id)!.status).toBe("obsolete");
  });

  it("cash basis VAT is due only when paid", async () => {
    const db = testDb();
    const paypal = newPaypal();
    change(db, "business", businessOf(db), { vat_method: "ist" });
    const invoice = await makeIssued(db, paypal);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBe(0);
    expect(ledger.balance(db, ledger.VAT_DEFERRED)).toBe(7220);
    paypal.pay(invoice.paypal_id!, 15000);
    await invoices.sync(db, invoice, paypal);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBeGreaterThan(0);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBeLessThan(7220);
    paypal.pay(invoice.paypal_id!);
    await invoices.sync(db, invoice, paypal);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBe(7220);
    expect(ledger.balance(db, ledger.VAT_DEFERRED)).toBe(0);
  });
});

describe("cancelling", () => {
  it("reverses the ledger and keeps the record", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    await invoices.cancel(db, invoice, paypal, "Wrong customer");
    expect(invoice.status).toBe("cancelled");
    for (const account of [ledger.RECEIVABLE, ledger.REVENUE, ledger.VAT_PAYABLE]) expect(ledger.balance(db, account)).toBe(0);
    expect(getInvoice(db, invoice.id)).toBeDefined();
    expect((await paypal.get(invoice.paypal_id!)).status).toBe("CANCELLED");
  });

  it("creates a valid credit note with the next number", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    await invoices.cancel(db, invoice, paypal, "Wrong customer");
    expect(invoice.credit_note_number!.endsWith("-0002")).toBe(true);
    const full = getInvoice(db, invoice.id, ["credit_note_xml", "credit_note_pdf"])!;
    expect((await einvoice.validateRules(full.credit_note_xml!)).problems).toEqual([]);
    expect(full.credit_note_xml!.toString()).toContain("<ram:TypeCode>381</ram:TypeCode>");
    expect(full.credit_note_xml!.toString()).toContain(invoice.number!);
    expect(await pdfText(full.credit_note_pdf!)).toContain("Stornorechnung");
    const next = await makeIssued(db, paypal, { customer: addCustomer(db, "Zwei GmbH") });
    expect(next.number!.endsWith("-0003")).toBe(true);
  });

  it("a small business credit note is valid", async () => {
    const db = testDb();
    const paypal = newPaypal();
    change(db, "business", businessOf(db), { small_business: true, vat_id: "", tax_number: "330/1234/5678" });
    const invoice = await makeIssued(db, paypal, { lines: [{ description: "Arbeit", quantity_milli: 1000, unit: "HUR", unit_price_cents: 30000, vat_bp: 0 }] });
    await invoices.cancel(db, invoice, paypal, "x");
    const full = getInvoice(db, invoice.id, ["credit_note_xml"])!;
    expect((await einvoice.validateRules(full.credit_note_xml!)).problems).toEqual([]);
  });

  it("cannot be done after a payment", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const invoice = await makeIssued(db, paypal);
    paypal.pay(invoice.paypal_id!, 100);
    await invoices.sync(db, invoice, paypal);
    await expect(invoices.cancel(db, invoice, paypal, "x")).rejects.toBeInstanceOf(InvoiceError);
  });

  it("only drafts can be deleted", async () => {
    const db = testDb();
    const paypal = newPaypal();
    const draft = draftFor(db, addCustomer(db).id);
    invoices.deleteDraft(db, draft);
    expect(getInvoice(db, draft.id)).toBeUndefined();
    const issued = await makeIssued(db, paypal);
    expect(() => invoices.deleteDraft(db, issued)).toThrow(InvoiceError);
  });
});

describe("clock and days late", () => {
  it("the demo clock moves today", () => {
    const db = memoryDb();
    expect(invoices.today(db)).toBe(realToday());
    invoices.setOffset(db, 20);
    expect(invoices.offsetDays(db)).toBe(20);
    expect(invoices.today(db)).toBe(addDays(realToday(), 20));
    invoices.setOffset(db, 5);
    expect(invoices.offsetDays(db)).toBe(5);
  });

  it("days overdue uses the due date, or the first unpaid plan payment", async () => {
    const db = testDb();
    const invoice = await makeIssued(db, newPaypal());
    const on = addDays(invoice.due_date!, 5);
    expect(invoices.daysOverdue(invoice, on, plansOf(db, invoice.id))).toBe(5);
    expect(activePlan(plansOf(db, invoice.id))).toBeUndefined();
  });
});
