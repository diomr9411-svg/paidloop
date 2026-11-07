// Shared test setup, the same as the Python conftest.py
import { AI, AiSchema, AiStatus, NoAI } from "../src/ai";
import { addDays } from "../src/dates";
import { Db } from "../src/db";
import * as invoices from "../src/invoices";
import { LineInput } from "../src/invoices";
import { SimulatedPayPal } from "../src/paypal";
import { createCustomer, Customer, Invoice } from "../src/repo";
import { memoryDb } from "./helpers";

/** A database with the owner's business already filled in. */
export function testDb(): Db {
  const db = memoryDb();
  db.insert("business", { name: "Beispiel Elektro GmbH", street: "Musterstraße 1", postcode: "32657", city: "Lemgo", vat_id: "DE123456789", email: "owner@example.com" });
  return db;
}

export const newPaypal = (): SimulatedPayPal => new SimulatedPayPal();
export const noAi = (): NoAI => new NoAI();

/** Returns a prepared answer, like a model that says exactly what a test needs. */
export class ScriptedAI implements AI {
  prompts: string[] = [];
  constructor(public answer: unknown = null) {}
  async askJson<T>(_system: string, user: string, schema: AiSchema<T>): Promise<T | null> {
    this.prompts.push(user);
    if (this.answer === null) return null;
    const parsed = schema.zod.safeParse(this.answer);
    return parsed.success ? parsed.data : null;
  }
  async status(): Promise<AiStatus> {
    return { available: true, model: "scripted" };
  }
}

export function addCustomer(db: Db, name = "Bäckerei Muster GmbH", options: Partial<Customer> = {}): Customer {
  return createCustomer(db, {
    name, street: "Musterweg 2", postcode: "32756", city: "Detmold", email: "kunde@example.com", is_business: true, language: "de", ...options,
  });
}

export const LINES: LineInput[] = [
  { description: "Badreparatur", quantity_milli: 4000, unit: "HUR", unit_price_cents: 6500, vat_bp: 1900 },
  { description: "Material", quantity_milli: 1000, unit: "H87", unit_price_cents: 12000, vat_bp: 1900 },
];

export interface IssuedOptions {
  customer?: Customer;
  lines?: LineInput[];
  issueDaysAgo?: number;
  propertyWork?: boolean;
}

export async function makeIssued(db: Db, paypal: SimulatedPayPal, options: IssuedOptions = {}): Promise<Invoice> {
  const customer = options.customer ?? addCustomer(db);
  const on = invoices.today(db);
  const issueDate = addDays(on, -(options.issueDaysAgo ?? 0));
  const invoice = invoices.saveDraft(db, null, {
    customer_id: customer.id, lines: options.lines ?? LINES, issue_date: issueDate, service_date: addDays(issueDate, -1),
    due_date: addDays(issueDate, 14), property_work: options.propertyWork ?? false,
  });
  const result = invoices.runCheck(db, invoice);
  if (!result.can_issue) throw new Error(`Check failed: ${result.issues.map((i) => i.rule_id).join(", ")}`);
  await invoices.issue(db, invoice, paypal);
  return invoice;
}

export function jump(db: Db, days: number): void {
  invoices.setOffset(db, invoices.offsetDays(db) + days);
}
