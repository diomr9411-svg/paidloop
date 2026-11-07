// Double-entry ledger. Every event has a unique key, so replaying an event changes nothing.
import { Db } from "./db";

export const RECEIVABLE = "receivable";
export const REVENUE = "revenue";
export const VAT_PAYABLE = "vat_payable";
export const VAT_DEFERRED = "vat_deferred"; // cash-basis VAT that is not due until the customer pays
export const CASH = "cash_paypal";
const ASSET_ACCOUNTS = new Set([RECEIVABLE, CASH]);

export class UnbalancedEntry extends Error {}

/** One line: [account, debit cents, credit cents] */
export type JournalInput = [account: string, debit: number, credit: number];

/** Book the lines. Returns false if this key was already booked. */
export function post(db: Db, key: string, description: string, bookedOn: string, lines: JournalInput[], invoiceId: number | null = null): boolean {
  const used = lines.filter(([, debit, credit]) => debit || credit);
  const debit = used.reduce((sum, line) => sum + line[1], 0);
  const credit = used.reduce((sum, line) => sum + line[2], 0);
  if (debit !== credit) throw new UnbalancedEntry(`Debits and credits differ for ${key}`);
  if (used.some((line) => line[1] < 0 || line[2] < 0)) throw new UnbalancedEntry(`Negative amount in ${key}`);

  return db.transaction(() => {
    if (db.scalar("SELECT id FROM journal_entry WHERE idempotency_key = ?", key)) return false;
    const entryId = db.insert("journal_entry", { idempotency_key: key, description, booked_on: bookedOn, invoice_id: invoiceId });
    for (const [account, d, c] of used) db.insert("journal_line", { entry_id: entryId, account, debit_cents: d, credit_cents: c });
    return true;
  });
}

/** Asset accounts count debit minus credit. All others count credit minus debit. */
export function balance(db: Db, account: string): number {
  const [row] = db.query("SELECT COALESCE(SUM(debit_cents),0) AS d, COALESCE(SUM(credit_cents),0) AS c FROM journal_line WHERE account = ?", account);
  return ASSET_ACCOUNTS.has(account) ? row.d - row.c : row.c - row.d;
}

export function totals(db: Db): [debit: number, credit: number] {
  const [row] = db.query("SELECT COALESCE(SUM(debit_cents),0) AS d, COALESCE(SUM(credit_cents),0) AS c FROM journal_line");
  return [row.d, row.c];
}
