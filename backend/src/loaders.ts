// Load many things in one query each, so a screen never runs one query per row.
// The ids travel as one JSON text parameter and json_each() turns it back into rows, which has no size limit.
import { Db } from "./db";
import { Customer, Installment, Invoice, PaymentPlan } from "./repo";

const asJson = (ids: Iterable<number>): string => JSON.stringify([...new Set(ids)]);

export function invoicesByIds(db: Db, ids: Iterable<number>): Map<number, Invoice> {
  const rows = db.rows("invoice", `SELECT ${db.columns("invoice")} FROM invoice WHERE id IN (SELECT value FROM json_each(?))`, asJson(ids)) as Invoice[];
  return new Map(rows.map((row) => [row.id, row]));
}

export function customersByIds(db: Db, ids: Iterable<number | null>): Map<number, Customer> {
  const wanted = [...ids].filter((id): id is number => id !== null);
  const rows = db.rows("customer", `SELECT ${db.columns("customer")} FROM customer WHERE id IN (SELECT value FROM json_each(?))`, asJson(wanted)) as Customer[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** Plans with their installments, grouped by invoice. Two queries however many invoices. */
export function plansByInvoiceIds(db: Db, ids: Iterable<number>): Map<number, PaymentPlan[]> {
  const json = asJson(ids);
  const plans = db.rows("payment_plan", `SELECT ${db.columns("payment_plan")} FROM payment_plan WHERE invoice_id IN (SELECT value FROM json_each(?)) ORDER BY id`, json) as PaymentPlan[];
  const installments = db.rows(
    "installment",
    `SELECT ${db.columns("installment")} FROM installment WHERE plan_id IN (SELECT id FROM payment_plan WHERE invoice_id IN (SELECT value FROM json_each(?))) ORDER BY plan_id, seq`,
    json,
  ) as Installment[];
  const byPlan = new Map<number, Installment[]>();
  for (const installment of installments) {
    if (!byPlan.has(installment.plan_id)) byPlan.set(installment.plan_id, []);
    byPlan.get(installment.plan_id)!.push(installment);
  }
  const result = new Map<number, PaymentPlan[]>();
  for (const plan of plans) {
    plan.installments = byPlan.get(plan.id) ?? [];
    if (!result.has(plan.invoice_id)) result.set(plan.invoice_id, []);
    result.get(plan.invoice_id)!.push(plan);
  }
  return result;
}

/** Which of these invoices wait for the owner's decision. */
export function pendingInvoiceIds(db: Db, ids: Iterable<number>): Set<number> {
  const rows = db.query("SELECT DISTINCT invoice_id FROM proposal WHERE status = 'pending' AND invoice_id IN (SELECT value FROM json_each(?))", asJson(ids));
  return new Set(rows.map((row) => row.invoice_id as number));
}
