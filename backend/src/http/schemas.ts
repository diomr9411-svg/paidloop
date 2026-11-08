// What the screens may send. The limits are the same as before.
import { z } from "zod";
import { isIsoDate } from "../dates";
import { MAX_TEXT_CHARS } from "../capture";
import { ValidationFailed } from "./errors";

const date = z.string().refine(isIsoDate, "not a date");
const nullableDate = date.nullable().default(null);
const text = (max: number, fallback = "") => z.string().max(max).default(fallback);
const num = (min: number, max: number) => z.number().min(min).max(max);

export const BusinessIn = z.object({
  name: z.string().max(200),
  street: text(200), postcode: text(20), city: text(100), vat_id: text(30), tax_number: text(30), email: text(200),
  small_business: z.boolean().default(false),
  vat_method: z.enum(["soll", "ist"]).default("soll"),
  max_installments: z.number().int().min(2).max(12).default(4),
  min_first_payment_pct: z.number().int().min(0).max(90).default(20),
  max_plan_days: z.number().int().min(30).max(365).default(90),
  min_installment_eur: num(1, 100000).default(20),
  reminder_gap_days: z.number().int().min(1).max(60).default(7),
  payment_days: z.number().int().min(0).max(90).default(14),
});

export const CustomerIn = z.object({
  name: z.string().min(1).max(200),
  street: text(200), postcode: text(20), city: text(100), email: text(200),
  is_business: z.boolean().default(true),
  language: z.enum(["de", "en"]).default("de"),
});

export const LineIn = z.object({
  description: text(300),
  quantity: num(0, 100000),
  unit: z.enum(["HUR", "H87"]).default("H87"),
  unit_price_eur: num(0, 10000000),
  vat_percent: num(0, 100).default(19),
});

export const DraftIn = z.object({
  customer_id: z.number().int().nullable().default(null),
  lines: z.array(LineIn).max(100),
  issue_date: nullableDate, service_date: nullableDate, due_date: nullableDate,
  property_work: z.boolean().default(false),
  source_text: text(MAX_TEXT_CHARS),
  capture_source: z.enum(["ai", "rules", "manual"]).default("manual"),
});

export const TextIn = z.object({ text: z.string().min(1).max(MAX_TEXT_CHARS) });
export const ChatIn = z.object({ text: z.string().max(5000) });
export const ApproveIn = z.object({ body: z.string().max(4000).nullable().default(null) });
export const JumpIn = z.object({ days: z.number().int().min(-365).max(365) });
export const PaymentIn = z.object({ amount_eur: z.number().gt(0).max(10000000), paid_on: nullableDate });
export const CancelIn = z.object({ reason: text(200) });
export const IssueIn = z.object({ seconds_to_issue: z.number().int().min(0).max(7 * 24 * 3600).nullable().default(null) });

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
export const InvoiceQuery = z.object({
  filter: z.string().max(20).default("all"),
  q: z.string().max(100).default(""),
  sort: z.enum(["newest", "number", "customer", "due", "amount"]).default("newest"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: int(1, 1000000).default(1),
  size: int(1, 100).default(25),
});
export const CustomerQuery = z.object({ q: z.string().max(100).default(""), limit: int(1, 500).default(200) });
export const AuditQuery = z.object({
  invoice_id: z.coerce.number().int().optional(),
  before_id: z.coerce.number().int().optional(),
  limit: int(1, 200).default(50),
});

/** Check input against a schema. A mismatch names the fields to fix. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ValidationFailed(result.error.issues.map((issue) => issue.path.join(".")));
}

/** A whole number in the address (an invoice id), or a validation error. */
export function idParam(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new ValidationFailed([name]);
  return Number(value);
}

// ---- connections (the owner's own keys)

const key = (max: number) => z.string().trim().max(max).regex(/^[A-Za-z0-9_-]*$/);
const email = z.string().trim().max(200).refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "not an email").default("");
const localUrl = z.string().trim().max(200).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "not a web address");

export const PaypalIn = z.object({
  client_id: key(200).min(10),
  client_secret: key(300).default(""), // empty keeps the secret in use
  webhook_id: key(100).default(""),
  buyer_email: email,
});

export const PaypalTestIn = z.object({
  client_id: key(200).default(""),
  client_secret: key(300).default(""),
});

export const AiIn = z.object({
  enabled: z.boolean(),
  base_url: localUrl.default("http://localhost:11434"),
  model: z.string().trim().max(100).regex(/^[A-Za-z0-9_.:/-]*$/).default(""),
  cpu_only: z.boolean().default(false),
}).refine((value) => !value.enabled || value.model !== "", { path: ["model"], message: "a model is needed" });

export const AiTestIn = z.object({ base_url: localUrl.default("http://localhost:11434") });
