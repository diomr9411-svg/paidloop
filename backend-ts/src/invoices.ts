// The invoice lifecycle: draft, check, issue, payments and cancellation.
import { randomBytes } from "node:crypto";
import * as audit from "./audit";
import * as compliance from "./compliance";
import { CheckResult, InvoiceFacts, Line, party, vatGroups } from "./compliance";
import { addDays, daysBetween as daysBetweenDates, germanDate, IsoDate, realToday } from "./dates";
import { Db } from "./db";
import * as einvoice from "./einvoice";
import { LocalizedError, t } from "./i18n";
import * as ledger from "./ledger";
import { Mutex } from "./lock";
import { lineNet, percentOf } from "./money";
import { InvoiceState, PaymentRequest, PayPalApi, PayPalError, RequestLine } from "./paypal";
import {
  activePlan, Business, businessOf, change, Customer, customerOf, getCustomer, getInvoice, Invoice, InvoiceLine, isPaidInstallment,
  linesOf, openCents, plansOf,
} from "./repo";
import { CANCELLED, CHECKED, DISPUTED, DRAFT, ISSUED, moveTo, ON_PLAN, OPEN_STATES, PAID } from "./states";

const issueLock = new Mutex();

/** A problem the owner can understand and fix. */
export class InvoiceError extends LocalizedError {}

// ---------------------------------------------------------------- demo clock

export function offsetDays(db: Db): number {
  const value = db.scalar<string>("SELECT value FROM app_state WHERE key = 'clock_offset_days'");
  return value === undefined ? 0 : Number(value);
}

export function today(db: Db): IsoDate {
  return addDays(realToday(), offsetDays(db));
}

export function setOffset(db: Db, days: number): void {
  db.run("INSERT INTO app_state (key, value) VALUES ('clock_offset_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(days));
}

// ---------------------------------------------------------------- reading

const lineFacts = (l: InvoiceLine): Line => ({
  description: l.description, quantity_milli: l.quantity_milli, unit_price_cents: l.unit_price_cents, vat_bp: l.vat_bp, net_cents: l.net_cents,
});

export function factsFor(db: Db, invoice: Invoice, business: Business, customer: Customer | null = customerOf(db, invoice), lines: InvoiceLine[] = linesOf(db, invoice.id)): InvoiceFacts {
  return {
    seller: party({ name: business.name, street: business.street, postcode: business.postcode, city: business.city, country: business.country, email: business.email }),
    buyer: customer
      ? party({ name: customer.name, street: customer.street, postcode: customer.postcode, city: customer.city, country: customer.country, email: customer.email })
      : party(),
    seller_vat_id: business.vat_id,
    seller_tax_number: business.tax_number,
    seller_small_business: business.small_business,
    buyer_is_business: customer ? customer.is_business : true,
    issue_date: invoice.issue_date,
    service_date: invoice.service_date,
    due_date: invoice.due_date,
    property_work: invoice.property_work,
    lines: lines.map(lineFacts),
    vat_cents: invoice.vat_cents,
    gross_cents: invoice.gross_cents,
    buyer_language: customer ? customer.language : "de",
  };
}

// ---------------------------------------------------------------- drafts

export interface LineInput {
  description: string;
  quantity_milli: number;
  unit: string;
  unit_price_cents: number;
  vat_bp: number;
}

/** Work out every line, then the invoice totals. VAT is worked out per rate. */
export function recalculate(db: Db, invoice: Invoice): void {
  const lines = linesOf(db, invoice.id);
  lines.forEach((line, index) => {
    change(db, "invoice_line", line, { position: index + 1, net_cents: lineNet(line.quantity_milli, line.unit_price_cents) });
  });
  const net = lines.reduce((sum, line) => sum + line.net_cents, 0);
  const vat = [...vatGroups(lines.map(lineFacts)).values()].reduce((sum, [, v]) => sum + v, 0);
  change(db, "invoice", invoice, { net_cents: net, vat_cents: vat, gross_cents: net + vat });
}

export interface DraftInput {
  customer_id: number | null;
  lines: LineInput[];
  issue_date: IsoDate | null;
  service_date: IsoDate | null;
  due_date: IsoDate | null;
  property_work: boolean;
  source_text?: string;
  capture_source?: string;
}

export function saveDraft(db: Db, existing: Invoice | null, input: DraftInput): Invoice {
  return db.transaction(() => {
    let invoice = existing;
    if (invoice && ![DRAFT, CHECKED].includes(invoice.status)) {
      throw new InvoiceError(t(
        "An issued invoice can't be changed. Cancel it and create a new one.",
        "Eine ausgestellte Rechnung kann nicht geändert werden. Stornieren Sie sie und erstellen Sie eine neue.",
      ));
    }
    if (!invoice) {
      const id = db.insert("invoice", { status: DRAFT, source_text: input.source_text ?? "", capture_source: input.capture_source ?? "manual" });
      invoice = getInvoice(db, id)!;
    }
    const business = businessOf(db);
    const customer = input.customer_id ? getCustomer(db, input.customer_id) : null;
    change(db, "invoice", invoice, {
      status: DRAFT, customer_id: customer ? customer.id : null,
      issue_date: input.issue_date, service_date: input.service_date, due_date: input.due_date, property_work: input.property_work,
    });
    db.run("DELETE FROM invoice_line WHERE invoice_id = ?", invoice.id);
    for (const line of input.lines) {
      db.insert("invoice_line", {
        invoice_id: invoice.id,
        description: line.description.trim(),
        quantity_milli: line.quantity_milli,
        unit: line.unit === "HUR" || line.unit === "H87" ? line.unit : "H87",
        unit_price_cents: line.unit_price_cents,
        vat_bp: business.small_business ? 0 : line.vat_bp,
      });
    }
    recalculate(db, invoice);
    audit.record(db, "owner", "draft_saved", invoice.id, { gross_cents: invoice.gross_cents });
    return invoice;
  });
}

export function runCheck(db: Db, invoice: Invoice): CheckResult {
  if (![DRAFT, CHECKED].includes(invoice.status)) throw new InvoiceError(t("Only drafts are checked.", "Nur Entwürfe werden geprüft."));
  const business = businessOf(db);
  const result = compliance.check(factsFor(db, invoice, business));
  return db.transaction(() => {
    change(db, "invoice", invoice, { status: result.can_issue ? CHECKED : DRAFT });
    audit.record(db, "rules", "checked", invoice.id, {
      can_issue: result.can_issue, errors: result.issues.filter((i) => i.severity === compliance.ERROR).map((i) => i.rule_id),
    });
    return result;
  });
}

// ---------------------------------------------------------------- issuing

const plain = (n: number): string => (n % 1 === 0 ? String(n) : String(Number(n.toFixed(2))));

/**
 * Use the items if PayPal's per-item VAT adds up to ours, otherwise one line per VAT rate.
 *
 * A legal invoice works out VAT per rate, but PayPal rounds per item. The two can differ by a cent,
 * and then the customer would be asked to pay a different amount from the invoice.
 */
export function requestLines(invoice: Invoice, lines: InvoiceLine[], customer: Customer | null): RequestLine[] {
  const perItemVat = lines.reduce((sum, line) => sum + percentOf(line.net_cents, line.vat_bp), 0);
  if (perItemVat === invoice.vat_cents && lines.every((line) => line.quantity_milli % 10 === 0)) {
    return lines.map((line) => ({
      name: line.description,
      quantity: plain(line.quantity_milli / 1000),
      unit_price_cents: line.unit_price_cents,
      vat_percent: line.vat_bp ? plain(line.vat_bp / 100) : null,
      hours: line.unit === "HUR",
    }));
  }
  const english = customer?.language === "en";
  return [...vatGroups(lines.map(lineFacts))].sort((a, b) => a[0] - b[0]).map(([bp, [net]]) => ({
    name: english
      ? `Invoice ${invoice.number}${bp ? ` (${(bp / 100).toFixed(0)}% VAT)` : ""}`
      : `Rechnung ${invoice.number}${bp ? ` (${(bp / 100).toFixed(0)}% USt.)` : ""}`,
    quantity: "1",
    unit_price_cents: net,
    vat_percent: bp ? plain(bp / 100) : null,
  }));
}

async function tryCancel(paypal: PayPalApi, paypalId: string): Promise<void> {
  try {
    await paypal.cancel(paypalId, "Replaced");
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
  }
}

/**
 * Issue the legal e-invoice and PayPal payment request together.
 *
 * Nothing is saved until everything worked, so a failure leaves the invoice number unused and numbers have no gaps.
 */
export async function issue(db: Db, invoiceIn: Invoice, paypal: PayPalApi): Promise<Invoice> {
  return await issueLock.runExclusive(async () => {
    const invoice = Object.assign(invoiceIn, getInvoice(db, invoiceIn.id)!);
    if (invoice.status !== CHECKED) {
      throw new InvoiceError(t("Run the check first. Only a checked invoice can be issued.", "Bitte zuerst prüfen. Nur eine geprüfte Rechnung kann ausgestellt werden."));
    }
    const business = businessOf(db);
    const customer = customerOf(db, invoice)!;
    const lines = linesOf(db, invoice.id);
    const facts = factsFor(db, invoice, business, customer, lines);
    const result = compliance.check(facts);
    if (!result.can_issue) {
      change(db, "invoice", invoice, { status: DRAFT });
      throw new InvoiceError(t("The invoice no longer passes the check.", "Die Rechnung besteht die Prüfung nicht mehr."));
    }

    const year = Number(invoice.issue_date!.slice(0, 4));
    const number = `${business.invoice_prefix}-${year}-${String(business.next_number).padStart(4, "0")}`;
    const units = lines.map((line) => line.unit);

    // Check first, so PayPal never gets a request for an invoice that would fail the official rules.
    try {
      await einvoice.create(facts, number, units, result.notes_to_print, null);
    } catch (error) {
      if (!(error instanceof einvoice.EInvoiceInvalid)) throw error;
      throw new InvoiceError(t(`The e-invoice failed the official rules: ${error.message}`, `Die E-Rechnung hat die offiziellen Regeln nicht bestanden: ${error.message}`));
    }

    const paypalNumber = number + (business.paypal_suffix ? `-${business.paypal_suffix}` : "");
    const numbered = { ...invoice, number };
    const request: PaymentRequest = {
      number: paypalNumber,
      issue_date: invoice.issue_date!,
      due_date: invoice.due_date!,
      note: customer.language === "en"
        ? `Payment request for invoice ${number}. You receive the invoice itself as an e-invoice (ZUGFeRD). This is not a second invoice.`
        : `Zahlungsaufforderung zu Rechnung ${number}. Die Rechnung selbst erhalten Sie als E-Rechnung (ZUGFeRD). Dies ist keine zweite Rechnung.`,
      recipient_name: customer.name,
      recipient_email: customer.email,
      lines: requestLines(numbered, lines, customer),
      invoicer_name: business.name,
    };

    let paypalId: string | null = null;
    let state: InvoiceState;
    let qr: Buffer | null = null;
    let final: einvoice.EInvoice;
    try {
      paypalId = await paypal.createInvoice(request);
      await paypal.send(paypalId);
      state = await paypal.get(paypalId);
      if (state.due_cents !== invoice.gross_cents) {
        throw new InvoiceError(t(
          `PayPal calculated ${state.due_cents} cents but the invoice says ${invoice.gross_cents}. Nothing was issued.`,
          `PayPal hat ${state.due_cents} Cent berechnet, die Rechnung nennt ${invoice.gross_cents}. Es wurde nichts ausgestellt.`,
        ));
      }
      try {
        qr = await paypal.qrCode(paypalId);
      } catch (error) {
        if (!(error instanceof PayPalError)) throw error;
        qr = null; // the link still works without the picture
      }
      final = await einvoice.create(facts, number, units, result.notes_to_print, state.pay_link, qr);
    } catch (error) {
      if (paypalId && (error instanceof PayPalError || error instanceof einvoice.EInvoiceInvalid || error instanceof InvoiceError)) await tryCancel(paypal, paypalId);
      if (error instanceof InvoiceError) throw error;
      if (error instanceof PayPalError || error instanceof einvoice.EInvoiceInvalid) {
        throw new InvoiceError(t(`Issuing failed, nothing was issued: ${error.message}`, `Das Ausstellen ist fehlgeschlagen, es wurde nichts ausgestellt: ${error.message}`));
      }
      throw error;
    }

    // Everything worked: save it all in one step
    db.transaction(() => {
      change(db, "invoice", invoice, {
        number, public_token: randomBytes(24).toString("base64url"),
        paypal_id: paypalId, paypal_number: paypalNumber, pay_link: state.pay_link,
        status: moveTo(invoice.status, ISSUED),
      });
      db.update("invoice", invoice.id, { qr_png: qr, xml: final.xml, pdf: final.pdf });
      change(db, "business", business, { next_number: business.next_number + 1 });
      const vatAccount = business.vat_method === "ist" ? ledger.VAT_DEFERRED : ledger.VAT_PAYABLE;
      ledger.post(db, `issue:${invoice.id}`, `Invoice ${number}`, invoice.issue_date!, [
        [ledger.RECEIVABLE, invoice.gross_cents, 0],
        [ledger.REVENUE, 0, invoice.net_cents],
        [vatAccount, 0, invoice.vat_cents],
      ], invoice.id);
      audit.record(db, "owner", "issued", invoice.id, {
        number, gross_cents: invoice.gross_cents, paypal_id: paypalId, official_rules_checked: final.rules_checked,
      });
    });
    return invoice;
  });
}

// ---------------------------------------------------------------- payments

/** Record new payments from PayPal. Safe to run any number of times. Returns the new amount. */
export function applyState(db: Db, invoice: Invoice, state: InvoiceState): number {
  let newCents = 0;
  for (const transaction of state.transactions) {
    if (db.scalar("SELECT id FROM payment WHERE external_id = ?", transaction.external_id)) continue;
    db.insert("payment", { invoice_id: invoice.id, external_id: transaction.external_id, amount_cents: transaction.amount_cents, paid_on: transaction.paid_on, method: transaction.method });
    change(db, "invoice", invoice, { paid_cents: invoice.paid_cents + transaction.amount_cents });
    newCents += transaction.amount_cents;
    ledger.post(db, `payment:${transaction.external_id}`, `Payment for ${invoice.number}`, transaction.paid_on,
      [[ledger.CASH, transaction.amount_cents, 0], [ledger.RECEIVABLE, 0, transaction.amount_cents]], invoice.id);
    releaseCashBasisVat(db, invoice, transaction.external_id, transaction.amount_cents, transaction.paid_on);
    audit.record(db, "paypal", "payment_received", invoice.id, {
      amount_cents: transaction.amount_cents, paypal_payment_id: transaction.external_id, open_cents: openCents(invoice),
    });
  }
  return newCents;
}

/** With cash-basis VAT (Ist), tax becomes due only when the customer pays. */
function releaseCashBasisVat(db: Db, invoice: Invoice, key: string, amount: number, on: IsoDate): void {
  if (businessOf(db).vat_method !== "ist" || !invoice.vat_cents || !invoice.gross_cents) return;
  const share = invoice.paid_cents >= invoice.gross_cents
    ? invoice.vat_cents - releasedVat(db, invoice)
    : Math.floor((amount * invoice.vat_cents) / invoice.gross_cents);
  if (share > 0) {
    ledger.post(db, `vat-release:${key}`, `VAT due for ${invoice.number}`, on,
      [[ledger.VAT_DEFERRED, share, 0], [ledger.VAT_PAYABLE, 0, share]], invoice.id);
  }
}

function releasedVat(db: Db, invoice: Invoice): number {
  return db.scalar(
    `SELECT COALESCE(SUM(l.credit_cents), 0) FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
     WHERE e.invoice_id = ? AND l.account = ?`, invoice.id, ledger.VAT_PAYABLE) ?? 0;
}

/** Ask PayPal about this invoice and its plan payments, then update everything. */
export async function sync(db: Db, invoice: Invoice, paypal: PayPalApi): Promise<number> {
  if (!OPEN_STATES.includes(invoice.status) || !invoice.paypal_id) return 0;
  const on = today(db);
  // Ask PayPal first, so nothing in the database waits during the slow network calls.
  const mainState = await paypal.get(invoice.paypal_id);
  const planStates: [number, InvoiceState][] = [];
  for (const plan of plansOf(db, invoice.id)) {
    if (!["active", "done"].includes(plan.status)) continue;
    for (const installment of plan.installments) {
      if (installment.paypal_id) planStates.push([installment.id, await paypal.get(installment.paypal_id)]);
    }
  }
  // The background check, the customer page and a webhook can all run at once. Everything below has no
  // await in it, so it runs without interruption. Reading fresh numbers first means a payment is never
  // lost or counted twice.
  return db.transaction(() => {
    Object.assign(invoice, getInvoice(db, invoice.id)!);
    if (!OPEN_STATES.includes(invoice.status)) return 0;
    let newCents = applyState(db, invoice, mainState);
    for (const [installmentId, state] of planStates) {
      newCents += applyState(db, invoice, state);
      db.update("installment", installmentId, { paid_cents: state.paid_cents });
    }
    if (invoice.gross_cents && invoice.paid_cents >= invoice.gross_cents) closeAsPaid(db, invoice, on);
    return newCents;
  });
}

export function closeAsPaid(db: Db, invoice: Invoice, on: IsoDate): void {
  change(db, "invoice", invoice, { status: moveTo(invoice.status, PAID), paid_on: on, paused_until: null });
  const plan = activePlan(plansOf(db, invoice.id));
  if (plan) db.update("payment_plan", plan.id, { status: "done" });
  db.run("UPDATE proposal SET status = 'obsolete' WHERE invoice_id = ? AND status = 'pending'", invoice.id);
  audit.record(db, "paypal", "invoice_paid", invoice.id, { paid_cents: invoice.paid_cents });
}

/**
 * Issued invoices are never deleted. A legal credit note (Stornorechnung) corrects them.
 *
 * Simply removing an invoice is not allowed in Germany, and VAT shown on it could still be owed.
 */
export async function cancel(db: Db, invoiceIn: Invoice, paypal: PayPalApi, reason: string): Promise<void> {
  if (!OPEN_STATES.includes(invoiceIn.status)) throw new InvoiceError(t("Only open invoices can be cancelled.", "Nur offene Rechnungen können storniert werden."));
  if (invoiceIn.paid_cents) throw new InvoiceError(t("This invoice has payments. Refund them first.", "Diese Rechnung hat Zahlungen. Erstatten Sie diese zuerst."));
  await issueLock.runExclusive(async () => {
    const invoice = Object.assign(invoiceIn, getInvoice(db, invoiceIn.id)!);
    const business = businessOf(db);
    const customer = customerOf(db, invoice);
    const lines = linesOf(db, invoice.id);
    const on = today(db);
    const number = `${business.invoice_prefix}-${Number(on.slice(0, 4))}-${String(business.next_number).padStart(4, "0")}`;
    const facts = { ...factsFor(db, invoice, business, customer, lines), issue_date: on };
    const original = germanDate(invoice.issue_date!);
    const notes = [customer?.language === "en" ? `Credit note for invoice ${invoice.number} of ${original}.` : `Stornorechnung zu Rechnung ${invoice.number} vom ${original}.`];
    let credit: einvoice.EInvoice;
    try {
      credit = await einvoice.create(facts, number, lines.map((l) => l.unit), notes, null, null, [invoice.number!, invoice.issue_date!]);
    } catch (error) {
      if (!(error instanceof einvoice.EInvoiceInvalid)) throw error;
      throw new InvoiceError(t(`The credit note failed the official rules: ${error.message}`, `Die Stornorechnung hat die offiziellen Regeln nicht bestanden: ${error.message}`));
    }
    // The payment requests at PayPal are cancelled first; the records change only after that
    const ids = [invoice.paypal_id, ...plansOf(db, invoice.id).flatMap((plan) => plan.installments.map((i) => i.paypal_id))];
    for (const paypalId of ids) if (paypalId) await tryCancel(paypal, paypalId);

    db.transaction(() => {
      change(db, "invoice", invoice, { credit_note_number: number });
      db.update("invoice", invoice.id, { credit_note_xml: credit.xml, credit_note_pdf: credit.pdf });
      change(db, "business", business, { next_number: business.next_number + 1 });
      const vatAccount = business.vat_method === "ist" ? ledger.VAT_DEFERRED : ledger.VAT_PAYABLE;
      ledger.post(db, `cancel:${invoice.id}`, `Cancelled ${invoice.number}`, on, [
        [ledger.REVENUE, invoice.net_cents, 0], [vatAccount, invoice.vat_cents, 0], [ledger.RECEIVABLE, 0, invoice.gross_cents],
      ], invoice.id);
      change(db, "invoice", invoice, { status: moveTo(invoice.status, CANCELLED) });
      db.run("UPDATE payment_plan SET status = 'declined' WHERE invoice_id = ? AND status IN ('active', 'offered')", invoice.id);
      db.run("UPDATE proposal SET status = 'obsolete' WHERE invoice_id = ? AND status = 'pending'", invoice.id);
      audit.record(db, "owner", "cancelled", invoice.id, { reason: reason.slice(0, 200), credit_note: number });
    });
  });
}

export function resumeAfterDispute(db: Db, invoice: Invoice): void {
  if (invoice.status !== DISPUTED) throw new InvoiceError(t("This invoice is not disputed.", "Diese Rechnung ist nicht strittig."));
  db.transaction(() => {
    change(db, "invoice", invoice, { status: moveTo(invoice.status, activePlan(plansOf(db, invoice.id)) ? ON_PLAN : ISSUED), paused_until: null });
    audit.record(db, "owner", "dispute_closed", invoice.id);
  });
}

/** Drafts have no number yet, so removing one leaves no gap. Issued invoices can only be cancelled. */
export function deleteDraft(db: Db, invoice: Invoice): void {
  if (![DRAFT, CHECKED].includes(invoice.status) || invoice.number) {
    throw new InvoiceError(t(
      "Only drafts can be deleted. Issued invoices stay on record and are cancelled instead.",
      "Nur Entwürfe können gelöscht werden. Ausgestellte Rechnungen bleiben erhalten und werden storniert.",
    ));
  }
  db.transaction(() => {
    audit.record(db, "owner", "draft_deleted", invoice.id);
    db.run("DELETE FROM invoice_line WHERE invoice_id = ?", invoice.id);
    db.delete("invoice", invoice.id);
  });
}

/** Days late, based on the earliest unpaid plan payment when a plan is active. */
export function daysOverdue(invoice: Invoice, on: IsoDate, plans: ReturnType<typeof plansOf>): number {
  const plan = activePlan(plans);
  if (plan) {
    const unpaid = plan.installments.filter((i) => !isPaidInstallment(i));
    if (unpaid.length) return daysBetweenDates(on, unpaid[0].due_date);
  }
  return invoice.due_date ? daysBetweenDates(on, invoice.due_date) : 0;
}
