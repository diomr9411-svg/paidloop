// Every route the screens use. Same addresses and answers as before.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import * as audit from "../audit";
import * as capture from "../capture";
import * as dashboard from "../dashboard";
import { addDays, IsoDate, realToday } from "../dates";
import * as demo from "../demo";
import * as followup from "../followup";
import { LocalizedError, pick, t } from "../i18n";
import * as invoices from "../invoices";
import * as ledger from "../ledger";
import * as negotiation from "../negotiation";
import { toCents } from "../money";
import { PayPalError } from "../paypal";
import {
  activePlan, businessOf, change, Customer, customerOf, getCustomer, getInvoice, Invoice, messagesOf, openCents, openOffer, plansOf, proposalsOf,
} from "../repo";
import { chat as negotiationChat } from "../messages";
import { nameKey } from "../schema";
import { languageOf, NOT_FOUND, ValidationFailed } from "./errors";
import {
  ApproveIn, AuditQuery, BusinessIn, CancelIn, ChatIn, CustomerIn, CustomerQuery, DraftIn, idParam, InvoiceQuery, IssueIn, JumpIn, parse, PaymentIn, TextIn,
} from "./schemas";
import { ConnectionsController } from "./connections.controller";
import { Services } from "./services";
import {
  businessJson, captureJson, checkJson, customerJson, findCustomer, invoiceDetail, planJson, proposalsJson, summaries,
} from "./views";

const LIST_FILTERS = new Set(["all", "open", "overdue", "on_plan", "disputed", "draft", "paid", "cancelled"]);
const END = "\u{10ffff}";

/** Prefix search as an index range. A "contains" search would read every row, and a LIKE search
 * can't use an ordinary index in SQLite, so a range is both exact and fast. */
const startsWith = (column: string, text: string): [string, string[]] => [`(${column} >= ? AND ${column} < ?)`, [text, text + END]];

function invoiceOr404(s: Services, id: number): Invoice {
  const invoice = getInvoice(s.db, id);
  if (!invoice) throw new LocalizedError(t("Invoice not found.", "Rechnung nicht gefunden."), 404);
  return invoice;
}

function byToken(s: Services, token: string): Invoice {
  const row = token.length >= 20 ? s.db.row("invoice", `SELECT ${s.db.columns("invoice")} FROM invoice WHERE public_token = ?`, token) : undefined;
  if (!row) throw new LocalizedError(t("This link is not valid.", "Dieser Link ist nicht gültig."), 404);
  return row as Invoice;
}

function sendFile(res: Response, content: Buffer | null | undefined, media: string, name: string): void {
  if (!content || !content.length) throw new LocalizedError(t("This file does not exist yet.", "Diese Datei gibt es noch nicht."), 404);
  const safe = [...name].filter((c) => /[A-Za-z0-9\-_.]/.test(c)).join("");
  res.status(200).set({ "Content-Type": media, "Content-Disposition": `attachment; filename="${safe}"` }).send(content);
}

const toLines = (lines: ReturnType<typeof DraftIn.parse>["lines"]): invoices.LineInput[] =>
  lines.map((l) => ({
    description: l.description, quantity_milli: Math.round(l.quantity * 1000), unit: l.unit,
    unit_price_cents: toCents(l.unit_price_eur), vat_bp: Math.round(l.vat_percent * 100),
  }));

// ------------------------------------------------------------------ health, business, customers

@Controller("api")
export class CoreController {
  constructor(@Inject(Services) private readonly s: Services) {}

  @Get("health")
  async health() {
    const { settings } = this.s;
    return {
      pending_approvals: this.s.db.scalar("SELECT COUNT(id) FROM proposal WHERE status = 'pending'"),
      sync: { ...this.s.syncState, interval_seconds: settings.syncIntervalSeconds },
      status: "ok",
      paypal_mode: this.s.paypal.simulated ? "simulated" : "sandbox",
      paypal_keys_set: settings.hasPaypalKeys,
      ai: await this.s.ai.status(),
      ai_model_set: Boolean(settings.ollamaModel),
      webhook_configured: Boolean(settings.paypalWebhookId),
    };
  }

  @Get("business")
  getBusiness() {
    return businessJson(businessOf(this.s.db));
  }

  @Put("business")
  putBusiness(@Body() body: unknown) {
    const { min_installment_eur, ...data } = parse(BusinessIn, body);
    const business = businessOf(this.s.db);
    this.s.db.transaction(() => {
      change(this.s.db, "business", business, { ...data, min_installment_cents: toCents(min_installment_eur) });
      audit.record(this.s.db, "owner", "settings_changed");
    });
    return businessJson(business);
  }

  @Get("customers")
  listCustomers(@Query() query: unknown) {
    const { q, limit } = parse(CustomerQuery, query);
    const db = this.s.db;
    let sql = `SELECT ${db.columns("customer")} FROM customer`;
    const params: unknown[] = [];
    if (q.trim()) {
      const [clause, values] = startsWith("name_key", nameKey(q));
      sql += ` WHERE ${clause}`;
      params.push(...values);
    }
    sql += " ORDER BY name_key LIMIT ?";
    return db.rows("customer", sql, ...params, limit).map((c) => customerJson(c as Customer));
  }

  /** Typing a known customer again updates them, so the same firm doesn't end up in the list twice. */
  @HttpCode(200)
  @Post("customers")
  addCustomer(@Body() body: unknown) {
    const data = parse(CustomerIn, body);
    const db = this.s.db;
    const same = db.rows("customer", `SELECT ${db.columns("customer")} FROM customer WHERE name_key = ? ORDER BY id`, nameKey(data.name)) as Customer[];
    for (const existing of same) {
      if (!existing.email || !data.email || existing.email.toLowerCase() === data.email.toLowerCase()) {
        const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== ""));
        if ("name" in changes) changes.name_key = nameKey(data.name);
        change(db, "customer", existing, changes);
        return customerJson(existing);
      }
    }
    const id = db.insert("customer", { ...data, name_key: nameKey(data.name) });
    return customerJson(getCustomer(db, id));
  }

  @Put("customers/:id")
  editCustomer(@Param("id") rawId: string, @Body() body: unknown) {
    const id = idParam(rawId, "customer_id");
    const data = parse(CustomerIn, body);
    const customer = getCustomer(this.s.db, id);
    if (!customer) throw new LocalizedError(t("Customer not found.", "Kunde nicht gefunden."), 404);
    change(this.s.db, "customer", customer, { ...data, name_key: nameKey(data.name) });
    return customerJson(customer);
  }

  // ---------------------------------------------------------------- capture

  @HttpCode(200)

  @Post("capture/text")
  async captureFromText(@Body() body: unknown) {
    const { text } = parse(TextIn, body);
    return captureJson(this.s.db, await capture.captureText(text, this.s.ai));
  }

  @HttpCode(200)

  @Post("capture/file")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: capture.MAX_FILE_BYTES + 1 } }))
  async captureFromFile(@UploadedFile() file: { buffer: Buffer } | undefined) {
    if (!file) throw new ValidationFailed(["file"]);
    return captureJson(this.s.db, await capture.captureText(await capture.textFromFile(file.buffer), this.s.ai));
  }

  // ---------------------------------------------------------------- follow-up agent and approvals

  @HttpCode(200)

  @Post("agent/run")
  async runAgent(@Req() req: Request) {
    const language = languageOf(req);
    const outcomes = await followup.run(this.s.db, this.s.paypal, this.s.ai, this.s.publicBase);
    return outcomes.map((outcome) => ({ ...outcome, reason: pick(outcome.reason, language) }));
  }

  @Get("approvals")
  approvals(@Req() req: Request) {
    const rows = this.s.db.rows("proposal", `SELECT ${this.s.db.columns("proposal")} FROM proposal WHERE status = 'pending' ORDER BY id`);
    return proposalsJson(this.s.db, rows as never, invoices.today(this.s.db), languageOf(req));
  }

  @HttpCode(200)

  @Post("approvals/:id/approve")
  async approve(@Param("id") rawId: string, @Body() body: unknown, @Req() req: Request) {
    const proposal = this.proposalOr404(idParam(rawId, "proposal_id"));
    const data = parse(ApproveIn, body);
    return { message: pick(await followup.approve(this.s.db, proposal, this.s.paypal, data.body), languageOf(req)) };
  }

  @HttpCode(200)

  @Post("approvals/:id/reject")
  reject(@Param("id") rawId: string, @Req() req: Request) {
    return { message: pick(followup.reject(this.s.db, this.proposalOr404(idParam(rawId, "proposal_id"))), languageOf(req)) };
  }

  private proposalOr404(id: number) {
    const proposal = this.s.db.get("proposal", id);
    if (!proposal) throw new LocalizedError(NOT_FOUND, 404);
    return proposal as never;
  }

  // ---------------------------------------------------------------- dashboard and audit

  @Get("dashboard")
  getDashboard() {
    return dashboard.build(this.s.db);
  }

  @Get("ledger")
  getLedger() {
    const accounts = [ledger.CASH, ledger.RECEIVABLE, ledger.REVENUE, ledger.VAT_PAYABLE, ledger.VAT_DEFERRED];
    const [debit, credit] = ledger.totals(this.s.db);
    return { accounts: Object.fromEntries(accounts.map((account) => [account, ledger.balance(this.s.db, account)])), debit, credit };
  }

  /** Newest first. before_id continues from the last row, so old pages are as fast as new ones. */
  @Get("audit")
  getAudit(@Query() query: unknown) {
    const { invoice_id, before_id, limit } = parse(AuditQuery, query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (invoice_id) { conditions.push("invoice_id = ?"); params.push(invoice_id); }
    if (before_id) { conditions.push("id < ?"); params.push(before_id); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.s.db.query(`SELECT id, at, actor, action, invoice_id, data, hash FROM audit_event ${where} ORDER BY id DESC LIMIT ?`, ...params, limit + 1);
    const shown = rows.slice(0, limit);
    return {
      events: shown.map((e) => ({ id: e.id, at: e.at, actor: e.actor, action: e.action, invoice_id: e.invoice_id, data: JSON.parse(e.data), hash: String(e.hash).slice(0, 12) })),
      next_before_id: rows.length > limit ? shown[shown.length - 1].id : null,
    };
  }

  /** Reads every row, so it is a separate call from showing the list. */
  @Get("audit/verify")
  verifyAudit() {
    return audit.verify(this.s.db);
  }

  // ---------------------------------------------------------------- demo tools

  @HttpCode(200)

  @Post("demo/reset")
  async demoReset() {
    await demo.reset(this.s.db, this.s.paypal, this.s.settings.sandboxBuyerEmail);
    return { status: "ok", today: invoices.today(this.s.db) };
  }

  @HttpCode(200)

  @Post("demo/jump")
  demoJump(@Body() body: unknown) {
    const data = parse(JumpIn, body);
    invoices.setOffset(this.s.db, invoices.offsetDays(this.s.db) + data.days);
    return { today: invoices.today(this.s.db), offset_days: invoices.offsetDays(this.s.db) };
  }

  @Get("demo/clock")
  demoClock() {
    return { today: invoices.today(this.s.db), offset_days: invoices.offsetDays(this.s.db) };
  }
}

// ------------------------------------------------------------------ invoices

@Controller("api/invoices")
export class InvoicesController {
  constructor(@Inject(Services) private readonly s: Services) {}

  private overdueSql(on: IsoDate): [string, unknown[]] {
    return [
      `((invoice.status IN ('issued','disputed') AND invoice.due_date < ?) OR (invoice.status = 'on_plan' AND EXISTS (
         SELECT 1 FROM payment_plan p JOIN installment i ON i.plan_id = p.id
         WHERE p.invoice_id = invoice.id AND p.status = 'active' AND i.paid_cents < i.amount_cents AND i.due_date < ?)))`,
      [on, on],
    ];
  }

  private filterSql(name: string, on: IsoDate): [string, unknown[]] | null {
    if (name === "open") return ["invoice.status IN ('issued','on_plan','disputed')", []];
    if (name === "overdue") return this.overdueSql(on);
    if (name === "draft") return ["invoice.status IN ('draft','checked')", []];
    if (["on_plan", "disputed", "paid", "cancelled"].includes(name)) return ["invoice.status = ?", [name]];
    return null;
  }

  private counts(on: IsoDate) {
    const byStatus = new Map(this.s.db.query("SELECT status, COUNT(id) AS n FROM invoice GROUP BY status").map((row) => [row.status as string, row.n as number]));
    const [overdue, params] = this.overdueSql(on);
    const get = (status: string): number => byStatus.get(status) ?? 0;
    return {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      open: get("issued") + get("on_plan") + get("disputed"),
      overdue: this.s.db.scalar(`SELECT COUNT(invoice.id) FROM invoice WHERE ${overdue}`, ...params) as number,
      on_plan: get("on_plan"),
      disputed: get("disputed"),
      draft: get("draft") + get("checked"),
      paid: get("paid"),
      cancelled: get("cancelled"),
    };
  }

  /** One page at a time. Filters and sorting use indexes, so this stays fast with many invoices. */
  @Get()
  list(@Query() query: unknown) {
    const { filter, q, sort, dir, page, size } = parse(InvoiceQuery, query);
    const db = this.s.db;
    const on = invoices.today(db);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const condition = this.filterSql(LIST_FILTERS.has(filter) ? filter : "all", on);
    if (condition) { conditions.push(condition[0]); params.push(...condition[1]); }
    const text = q.trim();
    if (text) {
      const [byNumber, numberParams] = startsWith("invoice.number", text.toUpperCase());
      const [byName, nameParams] = startsWith("customer.name_key", nameKey(text));
      conditions.push(`(${byNumber} OR invoice.customer_id IN (SELECT customer.id FROM customer WHERE ${byName}))`);
      params.push(...numberParams, ...nameParams);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.scalar(`SELECT COUNT(invoice.id) FROM invoice ${where}`, ...params) as number;
    const column = { newest: "invoice.id", number: "invoice.number", customer: "customer.name_key", due: "invoice.due_date", amount: "invoice.gross_cents" }[sort];
    const join = sort === "customer" ? "LEFT JOIN customer ON invoice.customer_id = customer.id" : "";
    // The id comes last, so rows with the same value keep one order between pages.
    const rows = db.rows(
      "invoice",
      `SELECT ${db.columns("invoice")} FROM invoice ${join} ${where} ORDER BY ${column} ${dir === "asc" ? "ASC" : "DESC"}, invoice.id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    ) as Invoice[];
    return { items: summaries(db, rows, on), total, page, size, counts: this.counts(on) };
  }

  @HttpCode(200)

  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    const data = parse(DraftIn, body);
    const invoice = invoices.saveDraft(this.s.db, null, {
      customer_id: data.customer_id, lines: toLines(data.lines), issue_date: data.issue_date ?? invoices.today(this.s.db),
      service_date: data.service_date, due_date: data.due_date, property_work: data.property_work,
      source_text: data.source_text, capture_source: data.capture_source,
    });
    return invoiceDetail(this.s.db, invoice, languageOf(req));
  }

  @Put(":id")
  update(@Param("id") rawId: string, @Body() body: unknown, @Req() req: Request) {
    const invoice = invoiceOr404(this.s, idParam(rawId, "invoice_id"));
    const data = parse(DraftIn, body);
    invoices.saveDraft(this.s.db, invoice, {
      customer_id: data.customer_id, lines: toLines(data.lines), issue_date: data.issue_date,
      service_date: data.service_date, due_date: data.due_date, property_work: data.property_work,
    });
    return invoiceDetail(this.s.db, getInvoice(this.s.db, invoice.id)!, languageOf(req));
  }

  @Delete(":id")
  remove(@Param("id") rawId: string) {
    invoices.deleteDraft(this.s.db, invoiceOr404(this.s, idParam(rawId, "invoice_id")));
    return { status: "deleted" };
  }

  @Get(":id")
  get(@Param("id") rawId: string, @Req() req: Request) {
    return invoiceDetail(this.s.db, invoiceOr404(this.s, idParam(rawId, "invoice_id")), languageOf(req));
  }

  @HttpCode(200)

  @Post(":id/check")
  check(@Param("id") rawId: string, @Req() req: Request) {
    return checkJson(invoices.runCheck(this.s.db, invoiceOr404(this.s, idParam(rawId, "invoice_id"))), languageOf(req));
  }

  @HttpCode(200)

  @Post(":id/issue")
  async issue(@Param("id") rawId: string, @Body() body: unknown, @Req() req: Request) {
    const invoice = invoiceOr404(this.s, idParam(rawId, "invoice_id"));
    const data = parse(IssueIn, body);
    await invoices.issue(this.s.db, invoice, this.s.paypal);
    if (data.seconds_to_issue !== null) change(this.s.db, "invoice", invoice, { seconds_to_issue: data.seconds_to_issue });
    return invoiceDetail(this.s.db, invoice, languageOf(req));
  }

  @HttpCode(200)

  @Post(":id/sync")
  async sync(@Param("id") rawId: string, @Req() req: Request) {
    const invoice = invoiceOr404(this.s, idParam(rawId, "invoice_id"));
    await invoices.sync(this.s.db, invoice, this.s.paypal);
    return invoiceDetail(this.s.db, invoice, languageOf(req));
  }

  /** For bank transfers. Many customers still pay outside PayPal, and the app must know. */
  @HttpCode(200)
  @Post(":id/record-payment")
  async recordPayment(@Param("id") rawId: string, @Body() body: unknown, @Req() req: Request) {
    const invoice = invoiceOr404(this.s, idParam(rawId, "invoice_id"));
    const data = parse(PaymentIn, body);
    const amount = toCents(data.amount_eur);
    if (!["issued", "disputed"].includes(invoice.status) || !invoice.paypal_id) {
      throw new LocalizedError(t("A payment can only be recorded on an open invoice without a plan.", "Eine Zahlung kann nur bei einer offenen Rechnung ohne Plan erfasst werden."));
    }
    if (amount > openCents(invoice)) throw new LocalizedError(t("The amount is higher than what is open.", "Der Betrag ist höher als der offene Betrag."));
    await this.s.paypal.recordPayment(invoice.paypal_id, amount, data.paid_on ?? realToday(), "Recorded by the owner");
    audit.record(this.s.db, "owner", "bank_payment_recorded", invoice.id, { amount_cents: amount });
    await invoices.sync(this.s.db, invoice, this.s.paypal);
    return invoiceDetail(this.s.db, invoice, languageOf(req));
  }

  @HttpCode(200)

  @Post(":id/cancel")
  async cancel(@Param("id") rawId: string, @Body() body: unknown, @Req() req: Request) {
    const invoice = invoiceOr404(this.s, idParam(rawId, "invoice_id"));
    await invoices.cancel(this.s.db, invoice, this.s.paypal, parse(CancelIn, body).reason);
    return invoiceDetail(this.s.db, invoice, languageOf(req));
  }

  @Get(":id/pdf")
  pdf(@Param("id") rawId: string, @Res() res: Response) {
    const id = idParam(rawId, "invoice_id");
    const invoice = getInvoice(this.s.db, id, ["pdf"]);
    if (!invoice) throw new LocalizedError(t("Invoice not found.", "Rechnung nicht gefunden."), 404);
    sendFile(res, invoice.pdf, "application/pdf", `${invoice.number}.pdf`);
  }

  @Get(":id/xml")
  xml(@Param("id") rawId: string, @Res() res: Response) {
    const id = idParam(rawId, "invoice_id");
    const invoice = getInvoice(this.s.db, id, ["xml"]);
    if (!invoice) throw new LocalizedError(t("Invoice not found.", "Rechnung nicht gefunden."), 404);
    sendFile(res, invoice.xml, "application/xml", `${invoice.number}.xml`);
  }

  @Get(":id/credit-note")
  creditNote(@Param("id") rawId: string, @Res() res: Response) {
    const id = idParam(rawId, "invoice_id");
    const invoice = getInvoice(this.s.db, id, ["credit_note_pdf"]);
    if (!invoice) throw new LocalizedError(t("Invoice not found.", "Rechnung nicht gefunden."), 404);
    sendFile(res, invoice.credit_note_pdf, "application/pdf", `${invoice.credit_note_number}.pdf`);
  }
}

// ------------------------------------------------------------------ customer pages (the long random token is the only way in)

@Controller("api")
export class PayController {
  constructor(@Inject(Services) private readonly s: Services) {}

  private payJson(invoice: Invoice) {
    const db = this.s.db;
    const business = businessOf(db);
    const language = negotiation.languageOfChat(db, invoice);
    const plans = plansOf(db, invoice.id);
    const plan = activePlan(plans);
    const customer = customerOf(db, invoice)!;
    return {
      number: invoice.number,
      status: invoice.status,
      seller: business.name,
      customer_name: customer.name,
      language,
      gross_cents: invoice.gross_cents,
      paid_cents: invoice.paid_cents,
      open_cents: openCents(invoice),
      due_date: invoice.due_date,
      pay_link: plan ? null : invoice.pay_link,
      plan: planJson(plan),
      offer: planJson(openOffer(plans)),
      messages: messagesOf(db, invoice.id).map((m) => ({ role: m.role, text: m.text })),
      welcome: negotiationChat("welcome", language),
      simulated: this.s.paypal.simulated,
    };
  }

  @Get("pay/:token")
  async page(@Param("token") token: string) {
    const invoice = byToken(this.s, token);
    try {
      await invoices.sync(this.s.db, invoice, this.s.paypal);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error; // still show the page; the next visit or background sync catches up
    }
    return this.payJson(getInvoice(this.s.db, invoice.id)!);
  }

  @HttpCode(200)

  @Post("pay/:token/chat")
  async chat(@Param("token") token: string, @Body() body: unknown) {
    const invoice = byToken(this.s, token);
    const data = parse(ChatIn, body);
    const reply = await negotiation.handleMessage(this.s.db, invoice, data.text, this.s.ai, this.s.paypal);
    return { reply: reply.text, intent: reply.intent, page: this.payJson(getInvoice(this.s.db, invoice.id)!) };
  }

  @HttpCode(200)

  @Post("pay/:token/offers/:planId/accept")
  async accept(@Param("token") token: string, @Param("planId") rawPlan: string) {
    const invoice = byToken(this.s, token);
    const planId = idParam(rawPlan, "plan_id");
    const reply = await negotiation.acceptOffer(this.s.db, invoice, planId, this.s.paypal);
    return { reply: reply.text, page: this.payJson(getInvoice(this.s.db, invoice.id)!) };
  }

  @Get("pay/:token/pdf")
  pdf(@Param("token") token: string, @Res() res: Response) {
    const found = byToken(this.s, token);
    const invoice = getInvoice(this.s.db, found.id, ["pdf"])!;
    sendFile(res, invoice.pdf, "application/pdf", `${invoice.number}.pdf`);
  }

  /** Only exists in simulator mode. It acts as PayPal when no sandbox keys are set. */
  @HttpCode(200)
  @Post("pay/:token/simulate-payment")
  async simulatePayment(@Param("token") token: string) {
    const paypal = this.s.paypal as unknown as { simulated: boolean; pay(id: string): void };
    if (!paypal.simulated) throw new LocalizedError(NOT_FOUND, 404);
    const invoice = byToken(this.s, token);
    const plan = activePlan(plansOf(this.s.db, invoice.id));
    if (plan) {
      const next = plan.installments.find((i) => i.paid_cents < i.amount_cents);
      if (next) paypal.pay(next.paypal_id!);
    } else if (openCents(invoice)) {
      paypal.pay(invoice.paypal_id!);
    }
    await invoices.sync(this.s.db, invoice, this.s.paypal);
    return this.payJson(getInvoice(this.s.db, invoice.id)!);
  }

  // ---------------------------------------------------------------- PayPal webhook

  @HttpCode(200)

  @Post("paypal/webhook")
  async webhook(@Body() event: unknown, @Req() req: Request) {
    if (!event || typeof event !== "object" || Array.isArray(event) || !(event as { id?: string }).id) throw new LocalizedError("Not a webhook event", 400);
    const body = event as { id: string; event_type?: string; resource?: { id?: string; invoice?: { id?: string } } };
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    if (!(await this.s.paypal.verifyWebhook(this.s.settings.paypalWebhookId, headers, body))) throw new LocalizedError("Signature check failed", 400);
    const db = this.s.db;
    if (db.scalar("SELECT id FROM webhook_event WHERE event_id = ?", body.id)) return { status: "already handled" };
    db.insert("webhook_event", { event_id: body.id, event_type: String(body.event_type ?? "").slice(0, 80) });
    const paypalId = body.resource?.id || body.resource?.invoice?.id;
    let invoice: Invoice | undefined;
    if (paypalId) {
      invoice = db.row("invoice", `SELECT ${db.columns("invoice")} FROM invoice WHERE paypal_id = ?`, paypalId) as Invoice | undefined;
      if (!invoice) {
        const planId = db.scalar<number>("SELECT plan_id FROM installment WHERE paypal_id = ?", paypalId);
        const invoiceId = planId ? db.scalar<number>("SELECT invoice_id FROM payment_plan WHERE id = ?", planId) : undefined;
        invoice = invoiceId ? getInvoice(db, invoiceId) : undefined;
      }
    }
    // The event is only a signal. PayPal's own record decides what was paid.
    if (invoice) await invoices.sync(db, invoice, this.s.paypal);
    audit.record(db, "paypal", "webhook", invoice ? invoice.id : null, { event_type: body.event_type ?? null });
    return { status: "ok" };
  }
}


export const CONTROLLERS = [CoreController, InvoicesController, PayController, ConnectionsController];
