// Typed rows and the small loaders the rest of the code uses. Files (PDF, XML, QR) load only when asked for.
import { Db } from "./db";
import { IsoDate } from "./dates";
import { nameKey } from "./schema";
import { OPEN_STATES } from "./states";

export interface Business {
  id: number; name: string; street: string; postcode: string; city: string; country: string;
  vat_id: string; tax_number: string; email: string; small_business: boolean;
  vat_method: string; invoice_prefix: string; next_number: number; paypal_suffix: string;
  max_installments: number; min_first_payment_pct: number; max_plan_days: number;
  min_installment_cents: number; reminder_gap_days: number; payment_days: number;
}

export interface Customer {
  id: number; name: string; name_key: string; street: string; postcode: string; city: string; country: string; email: string;
  is_business: boolean; language: string;
  history_paid_count: number; history_avg_days_late: number; history_unpaid_count: number;
}

export interface Invoice {
  id: number; customer_id: number | null; number: string | null; status: string;
  issue_date: IsoDate | null; service_date: IsoDate | null; due_date: IsoDate | null;
  property_work: boolean; source_text: string; capture_source: string;
  net_cents: number; vat_cents: number; gross_cents: number; paid_cents: number;
  paypal_id: string | null; paypal_number: string | null; pay_link: string | null;
  qr_png?: Buffer | null; xml?: Buffer | null; pdf?: Buffer | null;
  credit_note_number: string | null; credit_note_xml?: Buffer | null; credit_note_pdf?: Buffer | null;
  public_token: string | null;
  reminder_level: number; last_reminder_on: IsoDate | null; default_since: IsoDate | null; paused_until: IsoDate | null; paid_on: IsoDate | null;
  seconds_to_issue: number | null; created_at: string;
}

export interface InvoiceLine {
  id: number; invoice_id: number; position: number; description: string; quantity_milli: number;
  unit: string; unit_price_cents: number; vat_bp: number; net_cents: number;
}

export interface Payment { id: number; invoice_id: number; external_id: string; amount_cents: number; paid_on: IsoDate; method: string }

export interface Installment {
  id: number; plan_id: number; seq: number; amount_cents: number; due_date: IsoDate;
  paypal_id: string | null; paypal_number: string | null; pay_link: string | null; paid_cents: number;
}

export interface PaymentPlan {
  id: number; invoice_id: number; status: string; created_by: string; created_at: string;
  installments: Installment[];
}

export interface Proposal {
  id: number; invoice_id: number; action: string; reason: string; reason_de: string; decided_by_ai: boolean;
  subject: string; body: string; payload: string; status: string; created_at: string; decided_at: string | null;
}

export interface ChatMessage { id: number; invoice_id: number; role: string; text: string; intent: string; created_at: string }

export const isPaidInstallment = (i: Installment): boolean => i.paid_cents >= i.amount_cents;
export const openCents = (invoice: Invoice): number => Math.max(invoice.gross_cents - invoice.paid_cents, 0);
export const isOpen = (invoice: Invoice): boolean => OPEN_STATES.includes(invoice.status);

/** Change a row in memory and in the database in one step. */
export function change<T extends { id: number }>(db: Db, table: string, row: T, changes: Partial<T> & Record<string, unknown>): void {
  Object.assign(row, changes);
  db.update(table, row.id, changes);
}

// ---------------------------------------------------------------- loaders

export function businessOf(db: Db): Business {
  const found = db.row("business", `SELECT ${db.columns("business")} FROM business ORDER BY id LIMIT 1`);
  if (found) return found as Business;
  const id = db.insert("business", {});
  return db.get("business", id) as Business;
}

export const getInvoice = (db: Db, id: number, files: string[] = []): Invoice | undefined => db.get("invoice", id, files) as Invoice | undefined;
export const getCustomer = (db: Db, id: number | null): Customer | null => (id ? ((db.get("customer", id) as Customer | undefined) ?? null) : null);
export const customerOf = (db: Db, invoice: Invoice): Customer | null => getCustomer(db, invoice.customer_id);

export function linesOf(db: Db, invoiceId: number): InvoiceLine[] {
  return db.rows("invoice_line", `SELECT ${db.columns("invoice_line")} FROM invoice_line WHERE invoice_id = ? ORDER BY position, id`, invoiceId) as InvoiceLine[];
}

export function paymentsOf(db: Db, invoiceId: number): Payment[] {
  return db.rows("payment", `SELECT ${db.columns("payment")} FROM payment WHERE invoice_id = ? ORDER BY id`, invoiceId) as Payment[];
}

export function plansOf(db: Db, invoiceId: number): PaymentPlan[] {
  const plans = db.rows("payment_plan", `SELECT ${db.columns("payment_plan")} FROM payment_plan WHERE invoice_id = ? ORDER BY id`, invoiceId) as PaymentPlan[];
  for (const plan of plans) {
    plan.installments = db.rows("installment", `SELECT ${db.columns("installment")} FROM installment WHERE plan_id = ? ORDER BY seq`, plan.id) as Installment[];
  }
  return plans;
}

export const activePlan = (plans: PaymentPlan[]): PaymentPlan | undefined => plans.find((plan) => plan.status === "active");
export const openOffer = (plans: PaymentPlan[]): PaymentPlan | undefined => plans.find((plan) => plan.status === "offered");

export function proposalsOf(db: Db, invoiceId: number): Proposal[] {
  return db.rows("proposal", `SELECT ${db.columns("proposal")} FROM proposal WHERE invoice_id = ? ORDER BY id`, invoiceId) as Proposal[];
}

export function messagesOf(db: Db, invoiceId: number): ChatMessage[] {
  return db.rows("chat_message", `SELECT ${db.columns("chat_message")} FROM chat_message WHERE invoice_id = ? ORDER BY id`, invoiceId) as ChatMessage[];
}

/** Everything about one invoice, for code that needs all of it. */
export interface InvoiceBundle {
  invoice: Invoice;
  customer: Customer | null;
  lines: InvoiceLine[];
  plans: PaymentPlan[];
}

export function bundleOf(db: Db, invoice: Invoice): InvoiceBundle {
  return { invoice, customer: customerOf(db, invoice), lines: linesOf(db, invoice.id), plans: plansOf(db, invoice.id) };
}

/** Add a customer. The search key is always filled in from the name. */
export function createCustomer(db: Db, values: Partial<Omit<Customer, "id" | "name_key">> & { name: string }): Customer {
  const id = db.insert("customer", { ...values, name_key: nameKey(values.name) });
  return db.get("customer", id) as Customer;
}
