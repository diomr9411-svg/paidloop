import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import { reminder, safeAiSentence } from "../src/messages";
import * as policy from "../src/policy";
import { assess } from "../src/risk";

describe("risk", () => {
  it("levels and reasons", () => {
    const good = assess({ paid_count: 8, avg_days_late: 1, unpaid_count: 0, days_overdue_now: 0, open_cents: 10000 });
    const bad = assess({ paid_count: 6, avg_days_late: 25, unpaid_count: 2, days_overdue_now: 20, open_cents: 300000 });
    expect(good.level).toBe("low");
    expect(bad.level).toBe("high");
    expect(bad.reasons.length).toBeGreaterThan(0);
    expect(bad.expected_days_late).toBeGreaterThan(good.expected_days_late);
  });

  it("says one invoice, not 1 invoice(s)", () => {
    const one = assess({ paid_count: 3, avg_days_late: 10, unpaid_count: 1, days_overdue_now: 0, open_cents: 100 });
    expect(one.reasons.map((r) => r.en)).toContain("1 earlier invoice was never paid.");
    expect(one.reasons.map((r) => r.de)).toContain("1 frühere Rechnung wurde nie bezahlt.");
  });
});

// Payment plans in code

const LIMITS = policy.defaultLimits();
const ON = "2026-11-07";

describe("payment plans", () => {
  it("the default offer fits the limits", () => {
    const offer = policy.buildOffer(45220, null, null, ON, LIMITS)!;
    expect(offer.payments).toHaveLength(3);
    expect(offer.payments.reduce((s, p) => s + p.amount_cents, 0)).toBe(45220);
    expect(policy.planProblems(45220, offer.payments, ON, LIMITS)).toEqual([]);
  });

  it.each([[12, null], [2, 100], [4, 1000], [3, 45000], [1, null], [60, 1]] as const)("a request for %s payments, first %s, stays inside the limits", (count, first) => {
    const offer = policy.buildOffer(45220, count, first, ON, LIMITS)!;
    expect(policy.planProblems(45220, offer.payments, ON, LIMITS)).toEqual([]);
    expect(offer.payments.reduce((s, p) => s + p.amount_cents, 0)).toBe(45220);
  });

  it("a request beyond the limits is marked adjusted", () => {
    expect(policy.buildOffer(45220, 12, null, ON, LIMITS)!.was_adjusted).toBe(true);
    expect(policy.buildOffer(45220, 3, null, ON, LIMITS)!.was_adjusted).toBe(false);
  });

  it("a small amount has no plan", () => {
    expect(policy.buildOffer(3000, 3, null, ON, LIMITS)).toBeNull();
  });

  it("every cent is kept when the amount does not divide", () => {
    for (const amount of [10000, 10001, 33333, 45220, 99999]) {
      for (const count of [2, 3, 4]) {
        const offer = policy.buildOffer(amount, count, null, ON, LIMITS)!;
        expect(offer.payments.reduce((s, p) => s + p.amount_cents, 0)).toBe(amount);
      }
    }
  });

  const bad: [string, [number, number][], string][] = [
    ["one payment", [[45220, 3]], "at least two"],
    ["tiny second payment", [[100, 3], [45120, 33]], "below"],
    ["does not add up", [[20000, 3], [20000, 33]], "add up"],
    ["too long", [[22610, 3], [22610, 300]], "longer"],
    ["wrong order", [[22610, 33], [22610, 3]], "order"],
    ["too many", [[9044, 3], [9044, 33], [9044, 63], [9044, 93], [9044, 123]], "More payments"],
  ];
  it.each(bad)("the plan check refuses: %s", (_name, payments, word) => {
    const built = payments.map(([amount_cents, days]) => ({ amount_cents, due_date: addDays(ON, days) }));
    expect(policy.planProblems(45220, built, ON, LIMITS).some((p) => p.includes(word))).toBe(true);
  });
});

describe("what the agent may do", () => {
  const facts = (changes: Partial<policy.FollowupFacts> = {}): policy.FollowupFacts => ({
    days_overdue: 0, reminder_level: 0, days_since_reminder: null, paused: false, disputed: false, open_cents: 10000, risk_level: "medium", ...changes,
  });

  it("waiting is always allowed, a stronger step only when its time has come", () => {
    expect(policy.allowedActions(facts({ days_overdue: -10 }), LIMITS)).toEqual([policy.WAIT]);
    expect(policy.allowedActions(facts({ days_overdue: -2 }), LIMITS)).toEqual([policy.WAIT, policy.PRE_DUE]);
    expect(policy.allowedActions(facts({ days_overdue: 3 }), LIMITS)).toEqual([policy.WAIT, policy.FRIENDLY]);
    expect(policy.allowedActions(facts({ days_overdue: 20, reminder_level: 1, days_since_reminder: 10 }), LIMITS)).toEqual([policy.WAIT, policy.FIRM]);
    expect(policy.allowedActions(facts({ days_overdue: 20, reminder_level: 1, days_since_reminder: 2 }), LIMITS)).toEqual([policy.WAIT]);
    expect(policy.allowedActions(facts({ days_overdue: 50, paused: true }), LIMITS)).toEqual([policy.WAIT]);
    expect(policy.allowedActions(facts({ days_overdue: 50, disputed: true }), LIMITS)).toEqual([policy.WAIT]);
  });

  it("serious steps need the owner, others do not", () => {
    expect(policy.gate(policy.FRIENDLY, facts({ days_overdue: 3 }), LIMITS)).toMatchObject({ allowed: true, needs_owner: false });
    expect(policy.gate(policy.FIRM, facts({ days_overdue: 20, reminder_level: 1, days_since_reminder: 9 }), LIMITS)).toMatchObject({ allowed: true, needs_owner: true });
    expect(policy.gate(policy.FINAL, facts({ days_overdue: 3 }), LIMITS).allowed).toBe(false);
  });

  it("the rules give a reliable customer more time", () => {
    const [action, reason] = policy.ruleChoice(facts({ days_overdue: 2, risk_level: "low" }), LIMITS);
    expect(action).toBe(policy.WAIT);
    expect(reason.de).toMatch(/zuverlässig/);
  });
});

describe("customer text", () => {
  it("screens the AI sentence", () => {
    expect(safeAiSentence("Ich hoffe, es geht Ihnen gut.")).toBe("Ich hoffe, es geht Ihnen gut.");
    for (const bad of ["Pay 50 euros", "We give a discount", "Unser Anwalt schreibt", "See https://x.example", "", "x".repeat(300), "你好 world"]) {
      expect(safeAiSentence(bad)).toBe("");
    }
    expect(safeAiSentence("Ich verstehe das.", "de")).toBe("Ich verstehe das.");
    expect(safeAiSentence("Ich verstehe das.", "en")).toBe("");
    expect(safeAiSentence("I understand.", "de")).toBe("");
    expect(safeAiSentence("Guten Tag, wie kann ich helfen?", "de")).toBe("");
  });

  it("a final notice in default shows the rate and fee", () => {
    const costs = { in_default: true, default_since: "2026-03-31", rate_percent: 10.52, days: 73, interest_cents: 2104, flat_fee_cents: 4000, total_cents: 6104 };
    const r = reminder(policy.FINAL, "de", "Müller GmbH", "RE-2026-0001", 100000, "2026-03-01", "http://x/pay", "Muster Elektro", costs);
    expect(r.subject).toBe("Letzte Mahnung: Rechnung RE-2026-0001");
    expect(r.body).toContain("Verzugszinsen von 10.52 %");
    expect(r.body).toContain("1.000,00 EUR");
    expect(r.body).toContain("01.03.2026");
    expect(r.english_for_owner).toContain("flat fee of 40.00 EUR");
  });
});
