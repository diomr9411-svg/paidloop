// The follow-up agent. Each day it looks at open invoices and picks the next step.
//
// The AI proposes. The policy gate checks. Code acts. Serious steps wait for the owner.
import { z } from "zod";
import { AI, aiSchema } from "./ai";
import * as audit from "./audit";
import { daysBetween, IsoDate } from "./dates";
import { Db } from "./db";
import { t, Text } from "./i18n";
import * as invoices from "./invoices";
import * as legal from "./legal";
import * as messages from "./messages";
import * as negotiation from "./negotiation";
import { PayPalApi, PayPalError } from "./paypal";
import * as policy from "./policy";
import {
  activePlan, Business, businessOf, change, Customer, customerOf, getInvoice, Invoice, isPaidInstallment, openCents, plansOf,
  PaymentPlan, Proposal, proposalsOf,
} from "./repo";
import * as risk from "./risk";
import { DISPUTED, ISSUED, ON_PLAN } from "./states";

const AI_TIMEOUT_SECONDS = 90;
export const ALREADY_DECIDED = t("This step was already decided.", "Dieser Schritt wurde schon entschieden.");
const LEVEL_AFTER: Record<string, number> = { [policy.FRIENDLY]: 1, [policy.FIRM]: 2, [policy.FINAL]: 3, [policy.OWNER_REVIEW]: 4 };
const OPEN = [ISSUED, ON_PLAN, DISPUTED];

export const AgentChoiceSchema = z.object({
  action: z.enum(["wait", "pre_due_note", "friendly_reminder", "firm_reminder", "final_notice", "owner_review"]),
  reason: z.string().max(300).default(""),
  friendly_sentence: z.string().max(240).default(""),
});
export type AgentChoice = z.infer<typeof AgentChoiceSchema>;
const AGENT_CHOICE_AI = aiSchema("AgentChoice", AgentChoiceSchema);

const SYSTEM_PROMPT = `You help a small German business decide the next step for an unpaid invoice.
You get facts as JSON and a list allowed_actions. Choose exactly one action from allowed_actions.
Most small delays resolve within a week, so waiting is good for reliable customers who are only a little late.
Do not choose a harsher step just because it is allowed if waiting a little is kinder and low risk, but do not
wait when the risk is high. reason is one short plain English sentence for the owner that uses the facts. Always write it.
friendly_sentence is one warm opening sentence in customer_language ("de" is German, "en" is English), with no numbers,
dates, promises, discounts, threats or legal words. Leave it empty if unsure.
Example answer: {"action":"friendly_reminder","reason":"Six days late and this customer often pays late, so a kind reminder is due.","friendly_sentence":"Ich hoffe, es geht Ihnen gut."}`;

export function limitsOf(business: Business): policy.Limits {
  return {
    max_installments: business.max_installments,
    min_first_payment_pct: business.min_first_payment_pct,
    max_plan_days: business.max_plan_days,
    min_installment_cents: business.min_installment_cents,
    reminder_gap_days: business.reminder_gap_days,
  };
}

/** Per customer: [invoices paid here, total days late]. One indexed query, not one per invoice. */
export function customerStats(db: Db, customerId: number | null = null): Map<number, [number, number]> {
  const where = customerId === null ? "" : "AND customer_id = ?";
  const rows = db.query(
    `SELECT customer_id, COUNT(id) AS n, COALESCE(SUM(MAX(0, CAST(julianday(paid_on) - julianday(due_date) AS INTEGER))), 0) AS late
     FROM invoice WHERE paid_on IS NOT NULL AND due_date IS NOT NULL AND customer_id IS NOT NULL ${where} GROUP BY customer_id`,
    ...(customerId === null ? [] : [customerId]),
  );
  return new Map(rows.map((row) => [row.customer_id as number, [row.n as number, Number(row.late)] as [number, number]]));
}

export function riskOf(db: Db, invoice: Invoice, customer: Customer, plans: PaymentPlan[], on: IsoDate, stats?: Map<number, [number, number]>): risk.Risk {
  const known = stats ?? customerStats(db, customer.id);
  const [paidHere, lateHere] = known.get(customer.id) ?? [0, 0];
  const paidCount = customer.history_paid_count + paidHere;
  const totalLate = customer.history_avg_days_late * customer.history_paid_count + lateHere;
  return risk.assess({
    paid_count: paidCount,
    avg_days_late: paidCount ? Math.floor(totalLate / paidCount) : 0,
    unpaid_count: customer.history_unpaid_count,
    days_overdue_now: Math.max(invoices.daysOverdue(invoice, on, plans), 0),
    open_cents: openCents(invoice),
  });
}

export function factsOf(invoice: Invoice, plans: PaymentPlan[], on: IsoDate, level: string): policy.FollowupFacts {
  return {
    days_overdue: invoices.daysOverdue(invoice, on, plans),
    reminder_level: invoice.reminder_level,
    days_since_reminder: invoice.last_reminder_on ? daysBetween(on, invoice.last_reminder_on) : null,
    paused: Boolean(invoice.paused_until && invoice.paused_until > on),
    disputed: invoice.status === DISPUTED,
    open_cents: openCents(invoice),
    risk_level: level,
  };
}

export function lateCostsOf(invoice: Invoice, customer: Customer, plans: PaymentPlan[], on: IsoDate): legal.LateCosts {
  void plans;
  const consumer = !customer.is_business;
  return legal.lateCosts(
    openCents(invoice), on, invoice.due_date!, consumer,
    consumer, // the check adds this notice to every consumer invoice
    invoice.default_since,
  );
}

export function targetPaypalId(invoice: Invoice, plans: PaymentPlan[]): string | null {
  const plan = activePlan(plans);
  if (plan) {
    const unpaid = plan.installments.filter((i) => !isPaidInstallment(i) && i.paypal_id);
    if (unpaid.length) return unpaid[0].paypal_id;
  }
  return invoice.paypal_id;
}

export function openAmountForMessage(invoice: Invoice, plans: PaymentPlan[]): [number, IsoDate] {
  const plan = activePlan(plans);
  if (plan) {
    const unpaid = plan.installments.filter((i) => !isPaidInstallment(i));
    if (unpaid.length) return [unpaid[0].amount_cents - unpaid[0].paid_cents, unpaid[0].due_date];
  }
  return [openCents(invoice), invoice.due_date!];
}

function composeMessage(invoice: Invoice, customer: Customer, plans: PaymentPlan[], business: Business, action: string, on: IsoDate, publicBase: string, aiSentence = ""): messages.Reminder {
  const [amount, due] = openAmountForMessage(invoice, plans);
  return messages.reminder(
    action, customer.language, customer.name, invoice.number!, amount, due,
    `${publicBase}/#/pay/${invoice.public_token}`, business.name,
    action === policy.FINAL && !activePlan(plans) ? lateCostsOf(invoice, customer, plans, on) : null,
    messages.safeAiSentence(aiSentence, customer.language),
  );
}

export interface Outcome {
  invoice_id: number;
  number: string;
  action: string;
  reason: Text;
  decided_by: string; // ai or rules
  status: string; // done, waiting_for_owner, nothing, failed
}

interface Choice {
  action: string;
  reason: Text;
  decided_by: string;
  sentence: string;
}

async function choose(db: Db, invoice: Invoice, customer: Customer, facts: policy.FollowupFacts, limits: policy.Limits, assessed: risk.Risk, ai: AI): Promise<Choice> {
  const options = policy.allowedActions(facts, limits);
  const [ruleAction, ruleReason] = policy.ruleChoice(facts, limits);
  if (options.length === 1) return { action: ruleAction, reason: ruleReason, decided_by: "rules", sentence: "" };
  const data = {
    days_overdue: facts.days_overdue,
    open_amount_eur: Math.round(facts.open_cents) / 100,
    customer_type: customer.is_business ? "business" : "private person",
    customer_language: customer.language,
    reminders_so_far: facts.reminder_level,
    risk_level: assessed.level,
    risk_reasons: assessed.reasons.map((reason) => reason.en),
    allowed_actions: options,
  };
  const answer = await ai.askJson(SYSTEM_PROMPT, JSON.stringify(data), AGENT_CHOICE_AI, AI_TIMEOUT_SECONDS);
  if (answer === null) return { action: ruleAction, reason: ruleReason, decided_by: "rules", sentence: "" };
  let verdict = policy.gate(answer.action, facts, limits);
  if (verdict.allowed && answer.action === policy.WAIT && ruleAction !== policy.WAIT && assessed.level !== "low") {
    // Waiting forever is also a risk: only a reliable customer can be given extra time by the AI.
    verdict = {
      allowed: false, needs_owner: false,
      reason: t("The AI wanted to wait, but this customer's risk is not low.", "Die KI wollte warten, aber das Risiko dieses Kunden ist nicht niedrig."),
    };
  }
  if (!verdict.allowed) {
    audit.record(db, "rules", "ai_choice_refused", invoice.id, { proposed: answer.action, why: verdict.reason.en });
    const refused = t(`The AI's choice was refused, so the rules decided. ${ruleReason.en}`, `Der Vorschlag der KI wurde abgelehnt, daher entschieden die Regeln. ${ruleReason.de}`);
    return { action: ruleAction, reason: refused, decided_by: "rules", sentence: answer.friendly_sentence };
  }
  const reason = answer.reason.split(/\s+/).filter(Boolean).join(" ").slice(0, 300);
  if (!reason || messages.looksGerman(reason) || !messages.LATIN_ONLY.test(reason.replace(/[0-9%€]/g, ""))) {
    // A step with no usable reason can't be explained to the owner, so the rules decide instead.
    return { action: ruleAction, reason: ruleReason, decided_by: "rules", sentence: answer.friendly_sentence };
  }
  // The small model writes good English reasons. German readers get the fixed text for the same step.
  const german = answer.action === ruleAction ? ruleReason.de : policy.reasonFor(answer.action, facts).de;
  return { action: answer.action, reason: t(reason, german), decided_by: "ai", sentence: answer.friendly_sentence };
}

export async function run(db: Db, paypal: PayPalApi, ai: AI, publicBase: string): Promise<Outcome[]> {
  const business = businessOf(db);
  const limits = limitsOf(business);
  const on = invoices.today(db);
  const outcomes: Outcome[] = [];
  const ids = db.query(`SELECT id FROM invoice WHERE status IN ('issued','on_plan','disputed') ORDER BY id`).map((row) => row.id as number);
  for (const id of ids) {
    const invoice = getInvoice(db, id)!;
    try {
      await invoices.sync(db, invoice, paypal);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error; // a stale view is safe here: a later run picks up the payment
    }
    Object.assign(invoice, getInvoice(db, id)!);
    if (!OPEN.includes(invoice.status)) {
      outcomes.push({ invoice_id: invoice.id, number: invoice.number!, action: policy.WAIT, reason: t("The invoice has just been paid.", "Die Rechnung wurde gerade bezahlt."), decided_by: "rules", status: "nothing" });
      continue;
    }
    if (proposalsOf(db, id).some((p) => p.status === "pending")) {
      outcomes.push({ invoice_id: invoice.id, number: invoice.number!, action: policy.WAIT, reason: t("A step is already waiting for your approval.", "Ein Schritt wartet bereits auf Ihre Freigabe."), decided_by: "rules", status: "nothing" });
      continue;
    }

    const customer = customerOf(db, invoice)!;
    const plans = plansOf(db, id);
    const assessed = riskOf(db, invoice, customer, plans, on);
    const facts = factsOf(invoice, plans, on, assessed.level);
    const { action, reason, decided_by, sentence } = await choose(db, invoice, customer, facts, limits, assessed, ai);
    // The AI can take a minute, so anything that changed meanwhile is read again before acting
    Object.assign(invoice, getInvoice(db, id)!);
    if (!OPEN.includes(invoice.status)) continue;
    const verdict = policy.gate(action, facts, limits);
    if (action === policy.WAIT || !verdict.allowed) {
      outcomes.push({ invoice_id: invoice.id, number: invoice.number!, action: policy.WAIT, reason, decided_by, status: "nothing" });
      continue;
    }

    const text = composeMessage(invoice, customer, plans, business, action, on, publicBase, sentence);
    if (verdict.needs_owner) {
      db.transaction(() => {
        db.insert("proposal", {
          invoice_id: invoice.id, action, reason: reason.en, reason_de: reason.de, decided_by_ai: decided_by === "ai",
          subject: text.subject, body: text.body, payload: JSON.stringify({ english: text.english_for_owner, german: text.german_for_owner }),
        });
        audit.record(db, decided_by, "proposed", invoice.id, { action, reason: reason.en, reason_de: reason.de });
      });
      outcomes.push({ invoice_id: invoice.id, number: invoice.number!, action, reason, decided_by, status: "waiting_for_owner" });
      continue;
    }

    try {
      await send(db, invoice, plans, paypal, action, text.subject, text.body, on, decided_by, reason);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      audit.record(db, "paypal", "reminder_failed", invoice.id, { action, error: error.message.slice(0, 200) });
      outcomes.push({
        invoice_id: invoice.id, number: invoice.number!, action,
        reason: t(`PayPal did not accept it: ${error.message}`, `PayPal hat es nicht angenommen: ${error.message}`), decided_by, status: "failed",
      });
      continue;
    }
    outcomes.push({ invoice_id: invoice.id, number: invoice.number!, action, reason, decided_by, status: "done" });
  }
  return outcomes;
}

async function send(db: Db, invoice: Invoice, plans: PaymentPlan[], paypal: PayPalApi, action: string, subject: string, body: string, on: IsoDate, actor: string, reason: Text): Promise<void> {
  const target = targetPaypalId(invoice, plans);
  if (action !== policy.OWNER_REVIEW && target) await paypal.remind(target, subject, body);
  db.transaction(() => {
    const changes: Record<string, unknown> = { last_reminder_on: on };
    if (action in LEVEL_AFTER) changes.reminder_level = LEVEL_AFTER[action];
    if (action === policy.FIRM && invoice.default_since === null) changes.default_since = on; // a clear reminder after the due date starts default (Sec. 286(1) BGB)
    change(db, "invoice", invoice, changes);
    audit.record(db, actor, action !== policy.OWNER_REVIEW ? "reminder_sent" : "owner_review_done", invoice.id, {
      action, reason: reason.en, reason_de: reason.de, subject,
    });
  });
}

/** The owner says yes. Everything is checked again, because things may have changed since the proposal. */
export async function approve(db: Db, proposal: Proposal, paypal: PayPalApi, editedBody: string | null = null): Promise<Text> {
  if (proposal.status !== "pending") return ALREADY_DECIDED;
  const invoice = getInvoice(db, proposal.invoice_id)!;
  const business = businessOf(db);
  const on = invoices.today(db);
  const decidedAt = new Date().toISOString();

  if (proposal.action === negotiation.PLAN_EXCEPTION) {
    return db.transaction(() => {
      const offered = negotiation.approveException(db, proposal, on);
      change(db, "proposal", proposal, { decided_at: decidedAt, status: "done" });
      audit.record(db, "owner", "approved", invoice.id, { action: proposal.action, offered });
      return offered
        ? t("The plan is now offered to the customer.", "Der Plan wird dem Kunden jetzt angeboten.")
        : t(
            "No new plan was offered, because this invoice already has a plan or nothing is open. Please contact the customer directly.",
            "Es wurde kein neuer Plan angeboten, weil diese Rechnung schon einen Plan hat oder nichts offen ist. Bitte kontaktieren Sie den Kunden direkt.",
          );
    });
  }
  if (proposal.action === negotiation.DISPUTE_REVIEW || proposal.action === negotiation.PAYMENT_CHECK) {
    return db.transaction(() => {
      change(db, "proposal", proposal, { decided_at: decidedAt });
      if (invoice.status === DISPUTED) invoices.resumeAfterDispute(db, invoice);
      change(db, "invoice", invoice, { paused_until: null });
      change(db, "proposal", proposal, { status: "done" });
      audit.record(db, "owner", "approved", invoice.id, { action: proposal.action });
      return t("Reminders continue as normal.", "Die Erinnerungen laufen normal weiter.");
    });
  }

  try {
    await invoices.sync(db, invoice, paypal);
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
  }
  Object.assign(invoice, getInvoice(db, invoice.id)!);
  if (![ISSUED, ON_PLAN].includes(invoice.status)) {
    change(db, "proposal", proposal, { decided_at: decidedAt, status: "obsolete" });
    return t("No reminder was sent, because the invoice is no longer open or is on hold.", "Es wurde keine Erinnerung gesendet, weil die Rechnung nicht mehr offen ist oder pausiert.");
  }

  const customer = customerOf(db, invoice)!;
  const plans = plansOf(db, invoice.id);
  const assessed = riskOf(db, invoice, customer, plans, on);
  const facts = factsOf(invoice, plans, on, assessed.level);
  const verdict = policy.gate(proposal.action, facts, limitsOf(business));
  if (!verdict.allowed) {
    db.transaction(() => {
      change(db, "proposal", proposal, { decided_at: decidedAt, status: "obsolete" });
      audit.record(db, "rules", "approval_refused", invoice.id, { action: proposal.action, why: verdict.reason.en });
    });
    return t(`Not sent: ${verdict.reason.en}`, `Nicht gesendet: ${verdict.reason.de}`);
  }

  const body = (editedBody || proposal.body).trim();
  await send(db, invoice, plans, paypal, proposal.action, proposal.subject, body, on, "owner", t(proposal.reason, proposal.reason_de || proposal.reason));
  db.transaction(() => {
    change(db, "proposal", proposal, { decided_at: decidedAt, body, status: "done" });
    audit.record(db, "owner", "approved", invoice.id, { action: proposal.action, edited: editedBody !== null });
  });
  return t("Sent.", "Gesendet.");
}

export function reject(db: Db, proposal: Proposal): Text {
  if (proposal.status !== "pending") return ALREADY_DECIDED;
  const invoice = getInvoice(db, proposal.invoice_id)!;
  db.transaction(() => {
    change(db, "proposal", proposal, { status: "rejected", decided_at: new Date().toISOString() });
    // Respect the owner's no: do not propose the same step again until the normal gap has passed.
    change(db, "invoice", invoice, { last_reminder_on: invoices.today(db) });
    audit.record(db, "owner", "rejected", invoice.id, { action: proposal.action });
  });
  return t("OK, nothing was sent.", "OK, es wurde nichts gesendet.");
}
