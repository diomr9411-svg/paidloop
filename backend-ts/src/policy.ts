// The safety core. The AI only proposes; this code decides what is allowed.
//
// Limits live here in code and in the owner's settings, never in an AI prompt, so no message from a
// customer can change them.
import { addDays, daysBetween, IsoDate } from "./dates";
import { t, Text } from "./i18n";

export const WAIT = "wait";
export const PRE_DUE = "pre_due_note";
export const FRIENDLY = "friendly_reminder";
export const FIRM = "firm_reminder";
export const FINAL = "final_notice";
export const OWNER_REVIEW = "owner_review";

export const SERIOUS_ACTIONS: ReadonlySet<string> = new Set([FIRM, FINAL, OWNER_REVIEW]);

export const FIRM_AFTER_DAYS = 14;
export const FINAL_AFTER_DAYS = 30;
export const OWNER_AFTER_DAYS = 45;
export const PRE_DUE_DAYS = 3;
export const PLAN_SPACING_DAYS = 30;
export const FIRST_PAYMENT_DAYS = 3;

export interface Limits {
  max_installments: number;
  min_first_payment_pct: number;
  max_plan_days: number;
  min_installment_cents: number;
  reminder_gap_days: number;
}

export const defaultLimits = (values: Partial<Limits> = {}): Limits => ({
  max_installments: 4, min_first_payment_pct: 20, max_plan_days: 90, min_installment_cents: 2000, reminder_gap_days: 7, ...values,
});

export interface FollowupFacts {
  days_overdue: number; // negative before the due date
  reminder_level: number; // 0 none, 1 friendly, 2 firm, 3 final, 4 owner
  days_since_reminder: number | null;
  paused: boolean;
  disputed: boolean;
  open_cents: number;
  risk_level: string; // low, medium or high
}

/** Waiting is always allowed. A stronger step is allowed only when its time has come. */
export function allowedActions(facts: FollowupFacts, limits: Limits): string[] {
  const actions = [WAIT];
  if (facts.paused || facts.disputed || facts.open_cents <= 0) return actions;
  if (facts.days_since_reminder !== null && facts.days_since_reminder < limits.reminder_gap_days) return actions;
  if (facts.days_overdue < 0) {
    if (-PRE_DUE_DAYS <= facts.days_overdue && facts.reminder_level === 0 && facts.days_since_reminder === null) actions.push(PRE_DUE);
    return actions;
  }
  if (facts.days_overdue >= 1 && facts.reminder_level === 0) actions.push(FRIENDLY);
  else if (facts.days_overdue >= FIRM_AFTER_DAYS && facts.reminder_level === 1) actions.push(FIRM);
  else if (facts.days_overdue >= FINAL_AFTER_DAYS && facts.reminder_level === 2) actions.push(FINAL);
  else if (facts.days_overdue >= OWNER_AFTER_DAYS && facts.reminder_level === 3) actions.push(OWNER_REVIEW);
  return actions;
}

export interface GateResult {
  allowed: boolean;
  needs_owner: boolean;
  reason: Text;
}

/** Every action passes here before it runs, whether it came from the AI or from rules. */
export function gate(action: string, facts: FollowupFacts, limits: Limits): GateResult {
  if (!allowedActions(facts, limits).includes(action)) {
    return { allowed: false, needs_owner: false, reason: t(`'${action}' is not allowed for this invoice right now.`, `'${action}' ist für diese Rechnung gerade nicht erlaubt.`) };
  }
  return { allowed: true, needs_owner: SERIOUS_ACTIONS.has(action), reason: t("Allowed by the owner's limits.", "Im Rahmen Ihrer Grenzen erlaubt.") };
}

/** A plain explanation of a step in both languages, whoever chose it. */
export function reasonFor(action: string, facts: FollowupFacts): Text {
  const days = facts.days_overdue;
  switch (action) {
    case PRE_DUE:
      return t("This customer often pays late, so a short note before the due date can help.",
        "Dieser Kunde zahlt oft spät, deshalb hilft eine kurze Nachricht vor der Fälligkeit.");
    case FRIENDLY:
      return t(`The invoice is ${days} days late and no reminder was sent yet.`, `Die Rechnung ist ${days} Tage überfällig, und es wurde noch nicht erinnert.`);
    case FIRM:
      return t(`The invoice is ${days} days late, and the friendly reminder did not work.`, `Die Rechnung ist ${days} Tage überfällig, die freundliche Erinnerung hat nicht gewirkt.`);
    case FINAL:
      return t(`The invoice is ${days} days late, even after a firm reminder.`, `Die Rechnung ist ${days} Tage überfällig, trotz Mahnung.`);
    case OWNER_REVIEW:
      return t(`The invoice is ${days} days late, even after a final notice. You should decide the next step.`,
        `Die Rechnung ist ${days} Tage überfällig, trotz letzter Mahnung. Bitte entscheiden Sie den nächsten Schritt.`);
    default:
      return t("No step is due yet.", "Noch kein Schritt fällig.");
  }
}

/** What the rules do when no AI is available, and the safe default when the AI's answer is refused. */
export function ruleChoice(facts: FollowupFacts, limits: Limits): [action: string, reason: Text] {
  const options = allowedActions(facts, limits);
  if (options.length === 1) {
    if (facts.paused) return [WAIT, t("Reminders are paused for this invoice.", "Die Erinnerungen für diese Rechnung sind pausiert.")];
    if (facts.disputed) {
      return [WAIT, t("The customer has raised a problem. The owner must look first.", "Der Kunde hat ein Problem gemeldet. Sie müssen zuerst prüfen.")];
    }
    return [WAIT, reasonFor(WAIT, facts)];
  }
  const action = options[options.length - 1];
  if (action === PRE_DUE && facts.risk_level !== "high") {
    return [WAIT, t("This customer usually pays on time, so no note is needed before the due date.",
      "Dieser Kunde zahlt meist pünktlich, daher ist vor der Fälligkeit keine Nachricht nötig.")];
  }
  if (action === FRIENDLY && facts.risk_level === "low" && facts.days_overdue < 4) {
    return [WAIT, t("This customer pays reliably and is only a few days late. Most such payments arrive within a week.",
      "Dieser Kunde zahlt zuverlässig und ist nur wenige Tage spät. Solche Zahlungen kommen meist innerhalb einer Woche.")];
  }
  return [action, reasonFor(action, facts)];
}

// Payment plans

export interface PlannedPayment {
  amount_cents: number;
  due_date: IsoDate;
}

export interface PlanOffer {
  payments: PlannedPayment[];
  was_adjusted: boolean;
}

export function mostInstallments(openCents: number, limits: Limits): number {
  const byDays = Math.floor(limits.max_plan_days / PLAN_SPACING_DAYS) + 1;
  const byAmount = limits.min_installment_cents ? Math.floor(openCents / limits.min_installment_cents) : limits.max_installments;
  return Math.max(Math.min(limits.max_installments, byDays, byAmount), 0);
}

export function smallestFirstPayment(openCents: number, limits: Limits): number {
  const fromPercent = Math.floor((openCents * limits.min_first_payment_pct + 99) / 100);
  return Math.max(fromPercent, Math.min(limits.min_installment_cents, openCents));
}

/** The closest plan inside the limits, or null if no plan fits at all. */
export function buildOffer(
  openCents: number,
  requestedCount: number | null,
  requestedFirstCents: number | null,
  today: IsoDate,
  limits: Limits,
): PlanOffer | null {
  const top = mostInstallments(openCents, limits);
  if (top < 2) return null;
  const wanted = requestedCount ? requestedCount : Math.min(3, top);
  const count = Math.min(Math.max(wanted, 2), top);
  let adjusted = count !== wanted;

  const lowest = smallestFirstPayment(openCents, limits);
  let first = requestedFirstCents ? requestedFirstCents : 0;
  if (first && first < lowest) adjusted = true;
  const evenFirst = Math.floor(openCents / count) + (openCents % count);
  if (!first) first = Math.max(lowest, evenFirst);
  first = Math.max(first, lowest);
  const highest = openCents - (count - 1) * limits.min_installment_cents;
  if (first > highest) {
    first = highest;
    adjusted = true;
  }

  const rest = openCents - first;
  const each = Math.floor(rest / (count - 1));
  const extra = rest - each * (count - 1);
  const payments: PlannedPayment[] = [{ amount_cents: first, due_date: addDays(today, FIRST_PAYMENT_DAYS) }];
  for (let index = 1; index < count; index++) {
    payments.push({
      amount_cents: each + (index === count - 1 ? extra : 0),
      due_date: addDays(today, FIRST_PAYMENT_DAYS + PLAN_SPACING_DAYS * index),
    });
  }
  return { payments, was_adjusted: adjusted };
}

/** Checks a finished plan. Nothing reaches a customer or PayPal without passing this. */
export function planProblems(openCents: number, payments: readonly PlannedPayment[], today: IsoDate, limits: Limits): string[] {
  const problems: string[] = [];
  if (payments.length < 2) problems.push("A plan needs at least two payments.");
  if (payments.length > limits.max_installments) problems.push("More payments than the owner allows.");
  if (payments.reduce((sum, p) => sum + p.amount_cents, 0) !== openCents) problems.push("The payments do not add up to the open amount.");
  if (payments.some((p) => p.amount_cents < limits.min_installment_cents)) problems.push("A payment is below the owner's minimum.");
  if (payments.length && payments[0].amount_cents * 100 < openCents * limits.min_first_payment_pct) problems.push("The first payment is below the owner's minimum.");
  if (payments.length) {
    const last = payments.map((p) => p.due_date).sort().at(-1)!;
    if (daysBetween(last, today) > limits.max_plan_days + FIRST_PAYMENT_DAYS) problems.push("The plan runs longer than the owner allows.");
  }
  const dates = payments.map((p) => p.due_date);
  const sorted = [...dates].sort();
  if (dates.some((d, i) => d !== sorted[i]) || new Set(dates).size !== dates.length) problems.push("The payment dates are not in order.");
  if (payments.length && payments[0].due_date < today) problems.push("A payment date is in the past.");
  return problems;
}
