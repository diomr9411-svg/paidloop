// Turning records into the JSON the screens read.
import * as capture from "../capture";
import * as compliance from "../compliance";
import { IsoDate } from "../dates";
import { Db } from "../db";
import * as followup from "../followup";
import { pick } from "../i18n";
import * as invoices from "../invoices";
import * as legal from "../legal";
import { Business, businessOf, Customer, customerOf, Installment, Invoice, InvoiceLine, isPaidInstallment, linesOf, messagesOf, openCents, openOffer, activePlan, PaymentPlan, paymentsOf, plansOf, Proposal, proposalsOf } from "../repo";
import { CheckResult } from "../compliance";
import { customersByIds, invoicesByIds, pendingInvoiceIds, plansByInvoiceIds } from "../loaders";
import { nameKey } from "../schema";

export const lineJson = (line: InvoiceLine) => ({
  description: line.description,
  quantity: line.quantity_milli / 1000,
  unit: line.unit,
  unit_price_cents: line.unit_price_cents,
  vat_percent: line.vat_bp / 100,
  net_cents: line.net_cents,
});

export const customerJson = (customer: Customer | null) =>
  customer && {
    id: customer.id, name: customer.name, street: customer.street, postcode: customer.postcode, city: customer.city,
    email: customer.email, is_business: customer.is_business, language: customer.language,
  };

const installmentJson = (i: Installment) => ({
  seq: i.seq, amount_cents: i.amount_cents, paid_cents: i.paid_cents, due_date: i.due_date, pay_link: i.pay_link, is_paid: isPaidInstallment(i),
});

export const planJson = (plan: PaymentPlan | undefined) =>
  plan ? { id: plan.id, status: plan.status, created_by: plan.created_by, installments: plan.installments.map(installmentJson) } : null;

export function invoiceSummary(invoice: Invoice, customer: Customer | null, plans: PaymentPlan[], on: IsoDate, hasPending: boolean) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    customer: customerJson(customer),
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    gross_cents: invoice.gross_cents,
    paid_cents: invoice.paid_cents,
    open_cents: openCents(invoice),
    days_overdue: invoice.due_date ? invoices.daysOverdue(invoice, on, plans) : 0,
    reminder_level: invoice.reminder_level,
    paused_until: invoice.paused_until,
    has_pending: hasPending,
  };
}

/** Summaries for many invoices, loading each kind of thing once. */
export function summaries(db: Db, rows: Invoice[], on: IsoDate) {
  const ids = rows.map((row) => row.id);
  const customers = customersByIds(db, rows.map((row) => row.customer_id));
  const plans = plansByInvoiceIds(db, ids);
  const pending = pendingInvoiceIds(db, ids);
  return rows.map((row) => invoiceSummary(row, customers.get(row.customer_id ?? -1) ?? null, plans.get(row.id) ?? [], on, pending.has(row.id)));
}

export function invoiceDetail(db: Db, invoice: Invoice, language = "en") {
  const on = invoices.today(db);
  const customer = customerOf(db, invoice);
  const plans = plansOf(db, invoice.id);
  const hasPending = proposalsOf(db, invoice.id).some((p) => p.status === "pending");
  const data: Record<string, unknown> = {
    ...invoiceSummary(invoice, customer, plans, on, hasPending),
    service_date: invoice.service_date,
    property_work: invoice.property_work,
    source_text: invoice.source_text,
    capture_source: invoice.capture_source,
    net_cents: invoice.net_cents,
    vat_cents: invoice.vat_cents,
    lines: linesOf(db, invoice.id).map(lineJson),
    pay_link: invoice.pay_link,
    credit_note_number: invoice.credit_note_number,
    public_token: invoice.public_token,
    default_since: invoice.default_since,
    last_reminder_on: invoice.last_reminder_on,
    payments: paymentsOf(db, invoice.id).map((p) => ({ amount_cents: p.amount_cents, paid_on: p.paid_on, method: p.method })),
    plan: planJson(activePlan(plans)),
    offer: planJson(openOffer(plans)),
    messages: messagesOf(db, invoice.id).map((m) => ({ role: m.role, text: m.text, intent: m.intent, at: m.created_at })),
  };
  if (invoice.number && customer) {
    const assessed = followup.riskOf(db, invoice, customer, plans, on);
    data.risk = { score: assessed.score, level: assessed.level, reasons: assessed.reasons.map((reason) => pick(reason, language)), expected_days_late: assessed.expected_days_late };
    const costs = followup.lateCostsOf(invoice, customer, plans, on);
    data.late_costs = {
      in_default: costs.in_default,
      default_since: costs.default_since,
      rate_percent: costs.rate_percent.toFixed(2),
      interest_cents: costs.interest_cents,
      flat_fee_cents: costs.flat_fee_cents,
      base_rate_percent: legal.BASE_RATE_PERCENT.toFixed(2),
    };
  }
  return data;
}

/** The approval queue, with every proposal's invoice loaded in a few queries. */
export function proposalsJson(db: Db, proposals: Proposal[], on: IsoDate, language: string) {
  const ids = proposals.map((p) => p.invoice_id);
  const rows = invoicesByIds(db, ids);
  const customers = customersByIds(db, [...rows.values()].map((row) => row.customer_id));
  const plans = plansByInvoiceIds(db, ids);
  return proposals.map((proposal) => {
    const invoice = rows.get(proposal.invoice_id)!;
    const payload = JSON.parse(proposal.payload || "{}") as { english?: string; german?: string };
    return {
      id: proposal.id,
      action: proposal.action,
      reason: language === "de" ? proposal.reason_de || proposal.reason : proposal.reason,
      decided_by_ai: proposal.decided_by_ai,
      subject: proposal.subject,
      body: proposal.body,
      english: payload.english ?? "",
      german: payload.german ?? "",
      status: proposal.status,
      created_at: proposal.created_at,
      invoice: invoiceSummary(invoice, customers.get(invoice.customer_id ?? -1) ?? null, plans.get(invoice.id) ?? [], on, true),
    };
  });
}

export const checkJson = (result: CheckResult, language = "en") => ({
  can_issue: result.can_issue,
  issues: result.issues.map((issue) => ({
    rule_id: issue.rule_id,
    severity: issue.severity,
    field: issue.field,
    law: language === "de" ? compliance.lawInGerman(issue.law) : issue.law,
    message: pick(issue.message, language),
    fix: pick(issue.fix, language),
  })),
  notes_to_print: result.notes_to_print,
});

/** Same name first, using the index. Then a customer whose name has every word. */
export function findCustomer(db: Db, name: string): Customer | null {
  const key = nameKey(name);
  if (!key) return null;
  const exact = db.row("customer", `SELECT ${db.columns("customer")} FROM customer WHERE name_key = ? ORDER BY id LIMIT 1`, key);
  if (exact) return exact as Customer;
  // The words of one extracted name can sit anywhere in a saved name. This looks at one small table
  // for one row, and only when the exact name was not found by its index above.
  const words = key.split(" ");
  const where = words.map(() => "name_key LIKE ? ESCAPE '\\'").join(" AND ");
  const params = words.map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`);
  return (db.row("customer", `SELECT ${db.columns("customer")} FROM customer WHERE ${where} ORDER BY name_key LIMIT 1`, ...params) as Customer | undefined) ?? null;
}

export function captureJson(db: Db, result: capture.CaptureResult) {
  const extracted = result.extracted;
  const found = extracted.customer_name ? findCustomer(db, extracted.customer_name) : null;
  const business = businessOf(db);
  return {
    source: result.source,
    read_from: result.read_from,
    source_text: result.source_text,
    extracted,
    unsure: result.unsure,
    // Both languages, because reading a note again would run the AI again.
    warnings: result.warnings.map((warning) => ({ en: warning.en, de: pick(warning, "de") })),
    property_work: result.property_work,
    known_customer: customerJson(found),
    today: invoices.today(db),
    payment_days: business.payment_days,
    default_vat_percent: business.small_business ? 0 : 19,
  };
}

export const businessJson = (business: Business) => ({
  name: business.name, street: business.street, postcode: business.postcode, city: business.city,
  vat_id: business.vat_id, tax_number: business.tax_number, email: business.email,
  small_business: business.small_business, vat_method: business.vat_method,
  max_installments: business.max_installments, min_first_payment_pct: business.min_first_payment_pct, max_plan_days: business.max_plan_days,
  min_installment_eur: business.min_installment_cents / 100,
  reminder_gap_days: business.reminder_gap_days, payment_days: business.payment_days,
});
