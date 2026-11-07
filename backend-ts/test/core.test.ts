import { beforeEach, describe, expect, it } from "vitest";
import * as audit from "../src/audit";
import { Db } from "../src/db";
import * as ledger from "../src/ledger";
import { eur, eurDe, lineNet, percentOf, toCents } from "../src/money";
import { CANCELLED, CHECKED, DISPUTED, DRAFT, InvalidTransition, ISSUED, moveTo, ON_PLAN, PAID } from "../src/states";
import { memoryDb } from "./helpers";

describe("money", () => {
  it.each([["12.34", 1234], ["0.005", 1], [120, 12000], ["452.20", 45220], ["0.004", 0], ["-0.005", -1], ["19", 1900]] as const)("to_cents %s", (value, cents) => {
    expect(toCents(value)).toBe(cents);
  });

  it("percent and line totals", () => {
    expect(percentOf(38000, 1900)).toBe(7220);
    expect(lineNet(1500, 6500)).toBe(9750);
    expect(lineNet(1, 1)).toBe(0); // 0.001 x 0.01 EUR rounds to 0
    expect(lineNet(500, 1)).toBe(1); // exactly half rounds up
    expect(eur(123450)).toBe("1,234.50 EUR");
    expect(eurDe(123450)).toBe("1.234,50 EUR");
    expect(eur(5)).toBe("0.05 EUR");
    expect(eur(-5)).toBe("-0.05 EUR");
  });
});

describe("invoice states", () => {
  it("allowed changes", () => {
    let status: string = DRAFT;
    for (const next of [CHECKED, ISSUED, PAID]) status = moveTo(status, next);
    expect(status).toBe(PAID);
    expect(moveTo(ISSUED, ISSUED)).toBe(ISSUED);
    expect(moveTo(DISPUTED, ON_PLAN)).toBe(ON_PLAN);
    expect(moveTo(ISSUED, CANCELLED)).toBe(CANCELLED);
  });

  it.each([[DRAFT, ISSUED], [DRAFT, PAID], [PAID, ISSUED], [ISSUED, DRAFT]])("%s to %s is refused", (start, target) => {
    expect(() => moveTo(start, target)).toThrow(InvalidTransition);
  });
});

describe("ledger", () => {
  let db: Db;
  beforeEach(() => { db = memoryDb(); });

  it("an entry must balance", () => {
    expect(() => ledger.post(db, "x", "bad", "2026-01-01", [[ledger.CASH, 100, 0], [ledger.RECEIVABLE, 0, 99]])).toThrow(ledger.UnbalancedEntry);
  });

  it("the same key is booked once", () => {
    const lines: ledger.JournalInput[] = [[ledger.CASH, 100, 0], [ledger.RECEIVABLE, 0, 100]];
    expect(ledger.post(db, "pay-1", "first", "2026-01-01", lines)).toBe(true);
    expect(ledger.post(db, "pay-1", "replay", "2026-01-01", lines)).toBe(false);
    expect(ledger.balance(db, ledger.CASH)).toBe(100);
  });

  it("debits equal credits after many entries", () => {
    ledger.post(db, "issue", "invoice", "2026-01-01", [[ledger.RECEIVABLE, 45220, 0], [ledger.REVENUE, 0, 38000], [ledger.VAT_PAYABLE, 0, 7220]]);
    ledger.post(db, "pay", "payment", "2026-01-02", [[ledger.CASH, 10000, 0], [ledger.RECEIVABLE, 0, 10000]]);
    expect(ledger.totals(db)).toEqual([55220, 55220]);
    expect(ledger.balance(db, ledger.RECEIVABLE)).toBe(35220);
    expect(ledger.balance(db, ledger.REVENUE)).toBe(38000);
    expect(ledger.balance(db, ledger.VAT_PAYABLE)).toBe(7220);
  });
});

describe("audit trail", () => {
  let db: Db;
  beforeEach(() => { db = memoryDb(); });

  it("chain is valid", () => {
    audit.record(db, "owner", "created", 1, { amount: 5 });
    audit.record(db, "ai", "proposed", 1, { note: "Müller" });
    expect(audit.verify(db)).toEqual({ ok: true, broken_at: null, checked: 2 });
  });

  it("detects a changed row", () => {
    audit.record(db, "owner", "created", 1, { amount: 5 });
    audit.record(db, "ai", "proposed", 1);
    audit.record(db, "owner", "approved", 1);
    db.run(`UPDATE audit_event SET data = '{"amount": 1}' WHERE id = 1`);
    const result = audit.verify(db);
    expect(result.ok).toBe(false);
    expect(result.broken_at).toBe(1);
  });

  it("detects a deleted row", () => {
    for (const action of ["a", "b", "c"]) audit.record(db, "owner", action, 1);
    db.run("DELETE FROM audit_event WHERE id = 2");
    expect(audit.verify(db).broken_at).toBe(3);
  });

  it("sorts keys so the same data gives the same text", () => {
    expect(audit.sortedJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});
