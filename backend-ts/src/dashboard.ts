// The owner's view of the money, and a simple work queue of what to do next.
//
// A real problem for small firms: not all cash is theirs. With standard (Soll) VAT, tax is due when the
// invoice is issued, even if the customer has not paid. So "spendable" here means cash minus the VAT
// the business has to pass on. Not tax advice.
//
// Numbers come from SQL on indexed columns, so this screen stays fast with many old invoices.
import { addDays, IsoDate } from "./dates";
import { Db } from "./db";
import * as followup from "./followup";
import * as invoices from "./invoices";
import * as ledger from "./ledger";
import { activePlan, businessOf, customerOf, getCustomer, getInvoice, Invoice, isPaidInstallment, openCents, PaymentPlan, plansOf } from "./repo";
import { Risk } from "./risk";
import { CHECKED, DISPUTED, DRAFT, ISSUED, ON_PLAN, PAID } from "./states";

const QUEUE_SIZE = 8;

/** Python's round(): halves go to the even number, so results match the earlier version. */
export function roundHalfEven(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = Math.abs(diff - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return rounded / factor;
}

interface Expected {
  expected_on: IsoDate;
  amount_cents: number;
  risk: string;
}

/** When is this money likely to arrive? Past behaviour moves the date. */
export function expectedPayments(invoice: Invoice, plans: PaymentPlan[], assessed: Risk, on: IsoDate): Expected[] {
  const plan = activePlan(plans);
  const items: [IsoDate, number][] = plan
    ? plan.installments.filter((i) => !isPaidInstallment(i)).map((i): [IsoDate, number] => [i.due_date, i.amount_cents - i.paid_cents])
    : [[invoice.due_date!, openCents(invoice)]];
  return items.map(([due, amount]) => {
    const later = addDays(due, assessed.expected_days_late);
    return { expected_on: later > on ? later : on, amount_cents: amount, risk: assessed.level };
  });
}

/** How well does getting paid work? Measured from real invoices, like cycle time in a factory. */
export function performance(db: Db) {
  const [paid] = db.query(
    `SELECT COUNT(id) AS n, AVG(julianday(paid_on) - julianday(issue_date)) AS avg_days,
            SUM(CASE WHEN paid_on <= due_date THEN 1 ELSE 0 END) AS on_time FROM invoice WHERE status = ?`, PAID);
  const [timed] = db.query("SELECT AVG(seconds_to_issue) AS avg_seconds, COUNT(seconds_to_issue) AS n FROM invoice WHERE seconds_to_issue IS NOT NULL");
  return {
    paid_count: paid.n as number,
    avg_days_to_paid: paid.avg_days !== null ? roundHalfEven(paid.avg_days, 1) : null,
    on_time_percent: paid.n ? roundHalfEven((100 * (paid.on_time ?? 0)) / paid.n) : null,
    avg_seconds_to_issue: timed.avg_seconds !== null ? roundHalfEven(timed.avg_seconds) : null,
    timed_invoices: timed.n as number,
  };
}

interface QueueItem {
  kind: "approval" | "no_reminder_yet" | "draft";
  action: string;
  invoice_id: number;
  number: string | null;
  customer: string;
  amount_cents: number;
  days_late: number;
}

/** Most valuable work first, one clear next step each: the owner pulls from this list. */
function buildQueue(db: Db, openRows: Invoice[], on: IsoDate): QueueItem[] {
  const queue: QueueItem[] = [];
  const withPending = new Set<number>();
  for (const proposal of db.query("SELECT id, invoice_id, action FROM proposal WHERE status = 'pending' ORDER BY id")) {
    withPending.add(proposal.invoice_id);
    const invoice = getInvoice(db, proposal.invoice_id)!;
    queue.push({
      kind: "approval", action: proposal.action, invoice_id: invoice.id, number: invoice.number,
      customer: customerOf(db, invoice)?.name ?? "", amount_cents: openCents(invoice),
      days_late: Math.max(invoices.daysOverdue(invoice, on, plansOf(db, invoice.id)), 0),
    });
  }
  for (const invoice of openRows) {
    const days = invoices.daysOverdue(invoice, on, plansOf(db, invoice.id));
    if (withPending.has(invoice.id) || days <= 0 || invoice.status === DISPUTED) continue;
    if (invoice.last_reminder_on === null) {
      queue.push({
        kind: "no_reminder_yet", action: "", invoice_id: invoice.id, number: invoice.number,
        customer: customerOf(db, invoice)!.name, amount_cents: openCents(invoice), days_late: days,
      });
    }
  }
  const drafts = db.rows("invoice", `SELECT ${db.columns("invoice")} FROM invoice WHERE status IN (?, ?) ORDER BY id DESC LIMIT ?`, DRAFT, CHECKED, QUEUE_SIZE) as Invoice[];
  for (const invoice of drafts) {
    queue.push({
      kind: "draft", action: "", invoice_id: invoice.id, number: null,
      customer: getCustomer(db, invoice.customer_id)?.name ?? "", amount_cents: invoice.gross_cents, days_late: 0,
    });
  }
  const order = { approval: 0, no_reminder_yet: 1, draft: 2 };
  queue.sort((a, b) => order[a.kind] - order[b.kind] || b.amount_cents - a.amount_cents);
  return queue.slice(0, QUEUE_SIZE);
}

export function build(db: Db) {
  const on = invoices.today(db);
  const business = businessOf(db);
  const openRows = db.rows("invoice", `SELECT ${db.columns("invoice")} FROM invoice WHERE status IN (?, ?, ?)`, ISSUED, ON_PLAN, DISPUTED) as Invoice[];
  const plansById = new Map(openRows.map((invoice) => [invoice.id, plansOf(db, invoice.id)]));
  const days = (invoice: Invoice): number => invoices.daysOverdue(invoice, on, plansById.get(invoice.id)!);

  const overdue = openRows.filter((invoice) => days(invoice) > 0);
  const cash = ledger.balance(db, ledger.CASH);
  const vatDue = ledger.balance(db, ledger.VAT_PAYABLE);
  let vatOnUnpaid = 0;
  for (const invoice of openRows) if (invoice.gross_cents) vatOnUnpaid += Math.floor((invoice.vat_cents * openCents(invoice)) / invoice.gross_cents);

  const aging = { not_due: 0, days_1_30: 0, days_31_60: 0, days_61_plus: 0 };
  for (const invoice of openRows) {
    const late = days(invoice);
    const bucket = late <= 0 ? "not_due" : late <= 30 ? "days_1_30" : late <= 60 ? "days_31_60" : "days_61_plus";
    aging[bucket] += openCents(invoice);
  }

  const stats = followup.customerStats(db);
  const buckets = { week: 0, month: 0, later: 0, at_risk: 0 };
  const upcoming: (Expected & { number: string | null; invoice_id: number; customer: string })[] = [];
  for (const invoice of openRows) {
    if (invoice.status === DISPUTED) {
      buckets.at_risk += openCents(invoice);
      continue;
    }
    const customer = customerOf(db, invoice)!;
    const plans = plansById.get(invoice.id)!;
    const assessed = followup.riskOf(db, invoice, customer, plans, on, stats);
    for (const item of expectedPayments(invoice, plans, assessed, on)) {
      if (item.risk === "high") buckets.at_risk += item.amount_cents;
      else if (item.expected_on <= addDays(on, 7)) buckets.week += item.amount_cents;
      else if (item.expected_on <= addDays(on, 30)) buckets.month += item.amount_cents;
      else buckets.later += item.amount_cents;
      upcoming.push({ number: invoice.number, invoice_id: invoice.id, customer: customer.name, ...item });
    }
  }

  const [debit, credit] = ledger.totals(db);
  const results = performance(db);
  const sum = (rows: Invoice[]): number => rows.reduce((total, invoice) => total + openCents(invoice), 0);
  const onPlan = openRows.filter((invoice) => invoice.status === ON_PLAN);
  const disputed = openRows.filter((invoice) => invoice.status === DISPUTED);
  return {
    today: on,
    open_cents: sum(openRows),
    open_count: openRows.length,
    overdue_cents: sum(overdue),
    overdue_count: overdue.length,
    on_plan_cents: sum(onPlan),
    on_plan_count: onPlan.length,
    disputed_cents: sum(disputed),
    disputed_count: disputed.length,
    paid_count: results.paid_count,
    cash_cents: cash,
    vat_due_cents: vatDue,
    vat_on_unpaid_cents: business.vat_method === "soll" ? vatOnUnpaid : 0,
    spendable_cents: cash - vatDue,
    vat_method: business.vat_method,
    forecast: buckets,
    aging,
    performance: results,
    queue: buildQueue(db, openRows, on),
    upcoming: upcoming.sort((a, b) => (a.expected_on < b.expected_on ? -1 : a.expected_on > b.expected_on ? 1 : 0)).slice(0, 8),
    ledger_balanced: debit === credit,
  };
}
