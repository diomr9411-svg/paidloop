// Database tables. Money is stored as whole cents, VAT rates as basis points (19% = 1900).
// Dates are text "YYYY-MM-DD", times are text in ISO form. Names match the earlier Python version.

export type ColumnType = "int" | "text" | "bool" | "blob" | "date" | "datetime";

export interface Column {
  type: ColumnType;
  /** null means the column may be empty. Without it the column is NOT NULL. */
  nullable?: boolean;
  /** Value used when an insert leaves the column out. "now" fills the current time. */
  default?: number | string | boolean | null | "now";
  unique?: boolean;
  /** Blob columns load only when asked for, so lists never read every PDF. */
  deferred?: boolean;
  references?: string;
}

export interface Table {
  columns: Record<string, Column>;
  /** First column is the primary key. Integer keys count up by themselves. */
  key?: string;
  indexes: Record<string, string[]>;
  uniques?: string[][];
}

const int = (def: number = 0): Column => ({ type: "int", default: def });
const text = (def = ""): Column => ({ type: "text", default: def });
const bool = (def = false): Column => ({ type: "bool", default: def });
const date = (): Column => ({ type: "date", nullable: true, default: null });
const nullableText = (unique = false): Column => ({ type: "text", nullable: true, default: null, unique });
const nullableInt = (): Column => ({ type: "int", nullable: true, default: null });
const blob = (): Column => ({ type: "blob", nullable: true, default: null, deferred: true });
const ref = (table: string, nullable = false): Column => ({ type: "int", references: table, ...(nullable ? { nullable: true, default: null } : {}) });
const now = (): Column => ({ type: "datetime", default: "now" });

export const TABLES: Record<string, Table> = {
  business: {
    columns: {
      id: { type: "int" },
      name: text(), street: text(), postcode: text(), city: text(), country: text("DE"),
      vat_id: text(), tax_number: text(), email: text(),
      small_business: bool(), // Sec. 19 UStG
      vat_method: text("soll"), // soll or ist
      invoice_prefix: text("RE"), next_number: int(1), paypal_suffix: text(),
      // Owner limits: the AI can never go outside these.
      max_installments: int(4), min_first_payment_pct: int(20), max_plan_days: int(90),
      min_installment_cents: int(2000), reminder_gap_days: int(7), payment_days: int(14),
    },
    key: "id",
    indexes: {},
  },
  customer: {
    columns: {
      id: { type: "int" },
      name: { type: "text" },
      name_key: text(), // for finding the same customer again
      street: text(), postcode: text(), city: text(), country: text("DE"), email: text(),
      is_business: bool(true), language: text("de"),
      // Earlier invoices outside this app, for the risk score
      history_paid_count: int(), history_avg_days_late: int(), history_unpaid_count: int(),
    },
    key: "id",
    indexes: { ix_customer_name_key: ["name_key"] },
  },
  invoice: {
    columns: {
      id: { type: "int" },
      customer_id: ref("customer", true),
      number: nullableText(true),
      status: text("draft"),
      issue_date: date(), service_date: date(), due_date: date(),
      property_work: bool(), // work on a building or land
      source_text: text(), capture_source: text(), // ai, rules, manual
      net_cents: int(), vat_cents: int(), gross_cents: int(), paid_cents: int(),
      paypal_id: nullableText(), paypal_number: nullableText(), pay_link: nullableText(),
      qr_png: blob(), xml: blob(), pdf: blob(),
      credit_note_number: nullableText(true), credit_note_xml: blob(), credit_note_pdf: blob(),
      public_token: nullableText(true),
      reminder_level: int(), last_reminder_on: date(), default_since: date(), paused_until: date(), paid_on: date(),
      seconds_to_issue: nullableInt(), // time study: note to issued
      created_at: now(),
    },
    key: "id",
    indexes: {
      ix_invoice_status_id: ["status", "id"], // list by status, newest first
      ix_invoice_status_due: ["status", "due_date"], // overdue and sort by due date
      ix_invoice_status_gross: ["status", "gross_cents"], // sort by amount
      ix_invoice_due: ["due_date"],
      ix_invoice_gross: ["gross_cents"],
      ix_invoice_customer_paid: ["customer_id", "paid_on", "due_date"], // payment history for the risk score
      ix_invoice_customer_id: ["customer_id", "id"], // filter by customer, newest first
      ix_invoice_paypal_id: ["paypal_id"], // find an invoice from a PayPal webhook
      ix_invoice_paid_results: ["status", "paid_on", "due_date", "issue_date"], // results on Home, from the index alone
      ix_invoice_timed: ["seconds_to_issue"], // time from note to issued invoice
    },
  },
  invoice_line: {
    columns: {
      id: { type: "int" },
      invoice_id: ref("invoice"),
      position: int(1), description: text(), quantity_milli: int(1000),
      unit: text("H87"), // HUR hours, H87 pieces
      unit_price_cents: int(), vat_bp: int(1900), net_cents: int(),
    },
    key: "id",
    indexes: { ix_invoice_line_invoice: ["invoice_id", "position"] },
  },
  payment: {
    columns: {
      id: { type: "int" },
      invoice_id: ref("invoice"),
      external_id: { type: "text", unique: true },
      amount_cents: { type: "int" }, paid_on: { type: "date" }, method: text(),
    },
    key: "id",
    indexes: { ix_payment_invoice: ["invoice_id"] },
  },
  payment_plan: {
    columns: {
      id: { type: "int" },
      invoice_id: ref("invoice"),
      status: text("offered"), // offered active done declined
      created_by: text("agent"), // agent or owner
      created_at: now(),
    },
    key: "id",
    indexes: { ix_plan_invoice_status: ["invoice_id", "status"] },
  },
  installment: {
    columns: {
      id: { type: "int" },
      plan_id: ref("payment_plan"),
      seq: { type: "int" }, amount_cents: { type: "int" }, due_date: { type: "date" },
      paypal_id: nullableText(), paypal_number: nullableText(), pay_link: nullableText(),
      paid_cents: int(),
    },
    key: "id",
    indexes: { ix_installment_plan: ["plan_id", "seq"], ix_installment_paypal_id: ["paypal_id"], ix_installment_due: ["due_date", "plan_id"] },
  },
  proposal: {
    // Something the agent wants to do. Serious steps wait here for the owner.
    columns: {
      id: { type: "int" },
      invoice_id: ref("invoice"),
      action: { type: "text" }, reason: text(), reason_de: text(),
      decided_by_ai: bool(), subject: text(), body: text(), payload: text("{}"),
      status: text("pending"), // pending approved rejected done obsolete
      created_at: now(), decided_at: { type: "datetime", nullable: true, default: null },
    },
    key: "id",
    indexes: { ix_proposal_status_id: ["status", "id"], ix_proposal_invoice_status: ["invoice_id", "status"] },
  },
  chat_message: {
    columns: {
      id: { type: "int" },
      invoice_id: ref("invoice"),
      role: { type: "text" }, // customer or agent
      text: { type: "text" }, intent: text(), created_at: now(),
    },
    key: "id",
    indexes: { ix_chat_invoice_role_time: ["invoice_id", "role", "created_at"], ix_chat_invoice_id: ["invoice_id", "id"] },
  },
  journal_entry: {
    columns: {
      id: { type: "int" },
      idempotency_key: { type: "text", unique: true },
      description: text(), invoice_id: ref("invoice", true), booked_on: { type: "date" },
    },
    key: "id",
    indexes: { ix_journal_entry_invoice: ["invoice_id"] },
  },
  journal_line: {
    columns: {
      id: { type: "int" },
      entry_id: ref("journal_entry"),
      account: { type: "text" }, debit_cents: int(), credit_cents: int(),
    },
    key: "id",
    indexes: { ix_journal_line_entry: ["entry_id"], ix_journal_line_account: ["account", "debit_cents", "credit_cents"] },
  },
  audit_event: {
    // Append-only log. Each row includes the hash of the row before it.
    columns: {
      id: { type: "int" },
      at: { type: "text" },
      actor: { type: "text" }, // ai rules owner customer paypal system
      action: { type: "text" }, invoice_id: nullableInt(), data: text("{}"),
      prev_hash: { type: "text" }, hash: { type: "text" },
    },
    key: "id",
    indexes: { ix_audit_invoice_id: ["invoice_id", "id"] },
  },
  webhook_event: {
    columns: { id: { type: "int" }, event_id: { type: "text", unique: true }, event_type: text(), received_at: now() },
    key: "id",
    indexes: {},
  },
  app_state: {
    columns: { key: { type: "text" }, value: text() },
    key: "key",
    indexes: {},
  },
};

/** Lower-case, one space between words. Used to find the same customer again. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "").toLocaleLowerCase("en").replace(/ß/g, "ss").split(/\s+/).filter(Boolean).join(" ");
}
