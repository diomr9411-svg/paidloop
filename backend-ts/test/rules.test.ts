import { describe, expect, it } from "vitest";
import {
  check, CONSUMER_NOTICE_DE, ERROR, InvoiceFacts, Line, lawInGerman, party, Party, RETENTION_NOTE_DE, SMALL_BUSINESS_NOTE_DE,
} from "../src/compliance";
import { addDays } from "../src/dates";
import * as legal from "../src/legal";

// German late payment law

const DUE = "2026-03-01";

describe("late payment law", () => {
  it("B2B default starts 30 days after the due date", () => {
    expect(legal.defaultStart(DUE, false, false, null)).toBe(addDays(DUE, 30));
  });

  it("a reminder after the due date starts default earlier", () => {
    const reminder = addDays(DUE, 5);
    expect(legal.defaultStart(DUE, false, false, reminder)).toBe(reminder);
  });

  it("a reminder before the due date does not count", () => {
    expect(legal.defaultStart(DUE, false, false, addDays(DUE, -2))).toBe(addDays(DUE, 30));
  });

  it("a consumer needs the notice for the 30-day rule", () => {
    expect(legal.defaultStart(DUE, true, false, null)).toBeNull();
    expect(legal.defaultStart(DUE, true, true, null)).toBe(addDays(DUE, 30));
  });

  it("no costs before default", () => {
    const costs = legal.lateCosts(100000, addDays(DUE, 10), DUE, false, false, null);
    expect(costs.in_default).toBe(false);
    expect(costs.total_cents).toBe(0);
  });

  it("B2B interest and flat fee", () => {
    const costs = legal.lateCosts(100000, addDays(DUE, 30 + 73), DUE, false, false, null);
    expect(costs.rate_percent).toBeCloseTo(legal.BASE_RATE_PERCENT + 9, 10);
    expect(costs.days).toBe(73);
    expect(costs.interest_cents).toBe(2104); // 1000 EUR x 10.52% x 73/365
    expect(costs.flat_fee_cents).toBe(4000);
    expect(costs.total_cents).toBe(6104);
  });

  it("consumer interest has no flat fee", () => {
    const costs = legal.lateCosts(100000, addDays(DUE, 30 + 73), DUE, true, true, null);
    expect(costs.rate_percent).toBeCloseTo(legal.BASE_RATE_PERCENT + 5, 10);
    expect(costs.interest_cents).toBe(1304);
    expect(costs.flat_fee_cents).toBe(0);
  });
});

// Compliance rules

const SELLER = party({ name: "Muster Elektro GmbH", street: "Beispielstr. 1", postcode: "32657", city: "Lemgo", email: "a@example.com" });
const BUYER = party({ name: "Beispiel GmbH", street: "Musterweg 2", postcode: "32756", city: "Detmold", email: "b@example.com" });
const line = (description: string, quantity_milli: number, unit_price_cents: number, vat_bp: number, net_cents: number): Line => ({
  description, quantity_milli, unit_price_cents, vat_bp, net_cents,
});

function facts(changes: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    seller: SELLER, buyer: BUYER, seller_vat_id: "DE123456789", seller_tax_number: "", seller_small_business: false,
    buyer_is_business: true, issue_date: "2026-11-07", service_date: "2026-11-05", due_date: "2026-11-21", property_work: false,
    lines: [line("Repair", 4000, 6500, 1900, 26000), line("Material", 1000, 12000, 1900, 12000)],
    vat_cents: 7220, gross_cents: 45220, buyer_language: "de",
    ...changes,
  };
}

const ruleIds = (result: ReturnType<typeof check>, severity?: string): Set<string> =>
  new Set(result.issues.filter((i) => !severity || i.severity === severity).map((i) => i.rule_id));

describe("compliance rules", () => {
  it("a complete invoice can be issued", () => {
    const result = check(facts());
    expect(result.can_issue).toBe(true);
    expect(ruleIds(result, ERROR).size).toBe(0);
    expect(ruleIds(result).has("R-EINVOICE")).toBe(true);
  });

  const cases: [string, Partial<InvoiceFacts>, string][] = [
    ["seller", { seller: party({ name: "X" }) }, "R-14-1-SELLER"],
    ["buyer name", { buyer: party({ name: "", email: "b@example.com" }) }, "R-14-1-BUYER"],
    ["buyer address", { buyer: party({ name: "Kunde", email: "b@example.com" }) }, "R-14-1-BUYER-ADDRESS"],
    ["tax id", { seller_vat_id: "" }, "R-14-2-TAX-ID"],
    ["issue date", { issue_date: null }, "R-14-3-DATE"],
    ["lines", { lines: [], vat_cents: 0, gross_cents: 0 }, "R-14-5-LINES"],
    ["service date", { service_date: null }, "R-14-6-SERVICE-DATE"],
    ["due date", { due_date: null }, "R-DUE"],
    ["due before issue", { due_date: "2026-01-01" }, "R-DUE-ORDER"],
    ["vat sum", { vat_cents: 7000, gross_cents: 45000 }, "R-MATH-VAT"],
    ["total", { gross_cents: 45221 }, "R-MATH-TOTAL"],
    ["email", { buyer: party({ name: "Beispiel GmbH", street: "Musterweg 2", postcode: "32756", city: "Detmold" }) }, "R-EMAIL"],
  ];
  it.each(cases)("%s is enforced", (_name, changes, rule) => {
    const result = check(facts(changes));
    expect(ruleIds(result, ERROR).has(rule)).toBe(true);
    expect(result.can_issue).toBe(false);
  });

  it("line math is rechecked", () => {
    const bad = [line("Repair", 4000, 6500, 1900, 25000)];
    expect(ruleIds(check(facts({ lines: bad, vat_cents: 4750, gross_cents: 29750 })), ERROR).has("R-MATH-LINE")).toBe(true);
  });

  it("empty description, quantity and price", () => {
    const result = check(facts({ lines: [line(" ", 0, 0, 1900, 0)], vat_cents: 0, gross_cents: 0 }));
    const ids = ruleIds(result, ERROR);
    for (const rule of ["R-14-5-DESC", "R-14-5-QTY", "R-PRICE"]) expect(ids.has(rule)).toBe(true);
  });

  it("an unsupported VAT rate", () => {
    const lines = [line("Repair", 1000, 10000, 1600, 10000)];
    expect(ruleIds(check(facts({ lines, vat_cents: 1600, gross_cents: 11600 })), ERROR).has("R-14-8-RATE")).toBe(true);
  });

  it("a small business must not show VAT", () => {
    expect(ruleIds(check(facts({ seller_small_business: true })), ERROR).has("R-19-NO-VAT")).toBe(true);
  });

  it("a small business without VAT gets the note", () => {
    const lines = [line("Repair", 4000, 6500, 0, 26000)];
    const result = check(facts({ seller_small_business: true, lines, vat_cents: 0, gross_cents: 26000 }));
    expect(result.can_issue).toBe(true);
    expect(result.notes_to_print).toContain(SMALL_BUSINESS_NOTE_DE);
    expect(ruleIds(result).has("R-EINVOICE")).toBe(false);
  });

  it("a small invoice can skip buyer address, tax id and service date", () => {
    const lines = [line("Repair", 1000, 10000, 1900, 10000)];
    const result = check(facts({ lines, vat_cents: 1900, gross_cents: 11900, seller_vat_id: "", buyer: party({ name: "Kunde", email: "b@example.com" }), service_date: null }));
    expect(result.can_issue).toBe(true);
    expect(ruleIds(result).has("R-33-BUYER")).toBe(true);
  });

  it("the 250 euro limit is inclusive and exact", () => {
    const atLimit = [line("Repair", 1000, 21008, 1900, 21008)]; // 21008 + 3992 VAT = 25000
    const over = [line("Repair", 1000, 21009, 1900, 21009)]; // 21009 + 3992 VAT = 25001
    const buyer: Party = party({ name: "Kunde", email: "b@example.com" });
    expect(check(facts({ lines: atLimit, vat_cents: 3992, gross_cents: 25000, buyer })).can_issue).toBe(true);
    const result = check(facts({ lines: over, vat_cents: 3992, gross_cents: 25001, buyer }));
    expect(ruleIds(result, ERROR).has("R-14-1-BUYER-ADDRESS")).toBe(true);
  });

  it("a consumer gets the 30-day notice", () => {
    const result = check(facts({ buyer_is_business: false }));
    expect(result.notes_to_print).toContain(CONSUMER_NOTICE_DE);
    expect(result.notes_to_print).not.toContain(RETENTION_NOTE_DE);
  });

  it("a private customer with property work gets the retention note", () => {
    const result = check(facts({ buyer_is_business: false, property_work: true }));
    expect(result.notes_to_print).toContain(RETENTION_NOTE_DE);
    expect(ruleIds(result).has("R-14-9-RETENTION")).toBe(true);
  });

  it("a business customer needs no retention note", () => {
    expect(check(facts({ property_work: true })).notes_to_print).not.toContain(RETENTION_NOTE_DE);
  });

  it("every issue has a law reference and a fix", () => {
    const result = check({
      seller: party(), buyer: party(), seller_vat_id: "", seller_tax_number: "", seller_small_business: false, buyer_is_business: true,
      issue_date: null, service_date: null, due_date: null, property_work: false, lines: [], vat_cents: 0, gross_cents: 0, buyer_language: "de",
    });
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.law).toBeTruthy();
      expect(issue.message.en).toBeTruthy();
      expect(issue.fix.de).toBeTruthy();
    }
  });

  it("English notes for an English-speaking customer", () => {
    const result = check(facts({ buyer_is_business: false, buyer_language: "en" }));
    expect(result.notes_to_print[0]).toMatch(/^Note: you will be in default/);
  });

  it("law references turn German", () => {
    expect(lawInGerman("Sec. 14(4) no. 5 UStG")).toBe("§ 14 Abs. 4 Nr. 5 UStG");
    expect(lawInGerman("Sec. 14(4) no. 7 and 8 UStG")).toBe("§ 14 Abs. 4 Nr. 7 und 8 UStG");
    expect(lawInGerman("Sec. 19 UStG, Sec. 14c UStG")).toBe("§ 19 UStG, § 14c UStG");
    expect(lawInGerman("PayPal invoicing")).toBe("PayPal-Rechnungen");
  });
});
