// PayPal Invoicing client, plus a simulator for running without keys and for tests.
//
// Never logs keys or tokens. The real client can only talk to the sandbox (see settings.ts).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IsoDate, realToday } from "./dates";
import { decimalText, toCents } from "./money";
import { Secret } from "./settings";

export class PayPalError extends Error {
  constructor(message: string, readonly status = 0, readonly issue = "", readonly debugId = "") {
    super(message);
  }
}

export interface RequestLine {
  name: string;
  quantity: string;
  unit_price_cents: number;
  vat_percent?: string | null;
  hours?: boolean;
}

export interface PaymentRequest {
  number: string;
  issue_date: IsoDate;
  due_date: IsoDate;
  note: string;
  recipient_name: string;
  recipient_email: string;
  lines: RequestLine[];
  invoicer_name?: string;
}

export interface Transaction {
  external_id: string;
  amount_cents: number;
  paid_on: IsoDate;
  method: string;
}

export interface InvoiceState {
  paypal_id: string;
  status: string;
  paid_cents: number;
  due_cents: number;
  transactions: Transaction[];
  pay_link: string | null;
}

/** What the app needs from PayPal. The real client and the simulator both do this. */
export interface PayPalApi {
  readonly simulated: boolean;
  createInvoice(request: PaymentRequest): Promise<string>;
  send(paypalId: string, notifyCustomer?: boolean): Promise<void>;
  get(paypalId: string): Promise<InvoiceState>;
  qrCode(paypalId: string): Promise<Buffer | null>;
  remind(paypalId: string, subject: string, note: string): Promise<void>;
  cancel(paypalId: string, note?: string): Promise<void>;
  recordPayment(paypalId: string, amountCents: number, on: IsoDate, note?: string): Promise<void>;
  findByNumber(number: string): Promise<string | null>;
  verifyWebhook(webhookId: string, headers: Record<string, string>, event: unknown): Promise<boolean>;
}

type Json = Record<string, any>;
const cents = (amount: Json | null | undefined): number => (amount ? toCents(String(amount.value ?? "0")) : 0);

export function parseState(body: Json): InvoiceState {
  const payments = body.payments ?? {};
  const transactions: Transaction[] = [];
  for (const item of payments.transactions ?? []) {
    if (!item.payment_id) continue;
    const day = String(item.payment_date ?? "").slice(0, 10);
    transactions.push({ external_id: item.payment_id, amount_cents: cents(item.amount), paid_on: day || realToday(), method: item.method ?? "" });
  }
  const metadata = body.detail?.metadata ?? {};
  return {
    paypal_id: body.id,
    status: body.status ?? "",
    paid_cents: cents(payments.paid_amount),
    due_cents: cents(body.due_amount),
    transactions,
    pay_link: metadata.recipient_view_url ?? null,
  };
}

/** PayPal returns the PNG as base64 text inside a multipart body. */
export function parseQr(contentType: string, body: string): Buffer | null {
  let text = body;
  if (contentType.includes("multipart")) {
    const split = body.includes("\r\n\r\n") ? body.split("\r\n\r\n") : body.split("\n\n");
    if (split.length < 2) return null;
    text = split.slice(1).join("\r\n\r\n").split("--")[0];
  }
  const bytes = Buffer.from(text.trim(), "base64");
  return bytes.length ? bytes : null;
}

export interface PayPalClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: Secret;
  /** For tests */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class PayPalClient implements PayPalApi {
  readonly simulated = false;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: Secret;
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: string | null = null;
  private tokenExpires = 0;
  private tokenRequest: Promise<string> | null = null;

  constructor(options: PayPalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.http = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpires) return Promise.resolve(this.token);
    // Calls that arrive together share one token request
    this.tokenRequest ??= this.fetchToken().finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  /** Asks PayPal for a token and nothing else, so the owner can test new keys safely. */
  async checkKeys(): Promise<void> {
    await this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    let response: Response;
    try {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret.reveal()}`).toString("base64");
      response = await this.http(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new PayPalError(`PayPal cannot be reached: ${(error as Error).name}`);
    }
    if (response.status !== 200) throw new PayPalError("PayPal refused the sandbox keys", response.status);
    const body = (await response.json()) as Json;
    this.token = body.access_token;
    this.tokenExpires = Date.now() + Math.max(Number(body.expires_in ?? 300) - 60, 30) * 1000;
    return this.token!;
  }

  private async request(method: string, path: string, options: { json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    // The same request ID on every retry stops PayPal from doing the work twice.
    if (method !== "GET" && !headers["PayPal-Request-Id"]) headers["PayPal-Request-Id"] = randomUUID();
    if (options.json !== undefined) headers["content-type"] = "application/json";
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      headers.authorization = `Bearer ${await this.accessToken()}`;
      let response: Response;
      try {
        response = await this.http(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: options.json === undefined ? undefined : JSON.stringify(options.json),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (error) {
        if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
          lastError = error;
          await this.sleep((attempt + 1) * 1000);
          continue;
        }
        throw new PayPalError(`PayPal cannot be reached: ${(error as Error).name}`);
      }
      if (response.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (response.status >= 500 && attempt < 2) {
        await this.sleep((attempt + 1) * 1000);
        continue;
      }
      if (response.status >= 400) throw await this.error(response);
      return response;
    }
    throw new PayPalError(`PayPal did not answer in time: ${(lastError as Error | undefined)?.name ?? "Error"}`);
  }

  private async error(response: Response): Promise<PayPalError> {
    const text = await response.text();
    let issue = "";
    let debugId = response.headers.get("paypal-debug-id") ?? "";
    let message = text.slice(0, 200);
    try {
      const body = JSON.parse(text) as Json;
      const details = body.details?.length ? body.details : [{}];
      issue = details[0].issue ?? "";
      message = details[0].description || body.message || message;
      debugId = body.debug_id ?? debugId;
    } catch {
      /* not JSON */
    }
    return new PayPalError(message, response.status, issue, debugId);
  }

  async createInvoice(request: PaymentRequest): Promise<string> {
    const items = request.lines.map((line) => ({
      name: line.name.slice(0, 200),
      quantity: line.quantity,
      unit_amount: { currency_code: "EUR", value: decimalText(line.unit_price_cents) },
      unit_of_measure: line.hours ? "HOURS" : "QUANTITY",
      ...(line.vat_percent ? { tax: { name: "VAT", percent: line.vat_percent } } : {}),
    }));
    const body: Json = {
      detail: {
        invoice_number: request.number,
        invoice_date: request.issue_date,
        currency_code: "EUR",
        note: request.note.slice(0, 4000),
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: request.due_date },
      },
      primary_recipients: [{ billing_info: { business_name: request.recipient_name.slice(0, 300), email_address: request.recipient_email } }],
      items,
      configuration: { allow_tip: false, tax_inclusive: false },
    };
    if (request.invoicer_name) body.invoicer = { business_name: request.invoicer_name.slice(0, 300) };
    try {
      const response = await this.request("POST", "/v2/invoicing/invoices", { json: body, headers: { Prefer: "return=representation" } });
      return ((await response.json()) as Json).id;
    } catch (error) {
      if (error instanceof PayPalError && error.issue === "DUPLICATE_INVOICE_NUMBER") {
        // A retry after a crash. Use the invoice that already exists instead of making a second one.
        const existing = await this.findByNumber(request.number);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async send(paypalId: string, notifyCustomer = true): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${paypalId}/send`, { json: { send_to_invoicer: false, send_to_recipient: notifyCustomer } });
  }

  async get(paypalId: string): Promise<InvoiceState> {
    return parseState((await (await this.request("GET", `/v2/invoicing/invoices/${paypalId}`)).json()) as Json);
  }

  async qrCode(paypalId: string): Promise<Buffer | null> {
    const response = await this.request("POST", `/v2/invoicing/invoices/${paypalId}/generate-qr-code`, { json: { width: 300, height: 300, action: "pay" } });
    return parseQr(response.headers.get("content-type") ?? "", await response.text());
  }

  async remind(paypalId: string, subject: string, note: string): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${paypalId}/remind`, {
      json: { subject: subject.slice(0, 4000), note: note.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true },
    });
  }

  async cancel(paypalId: string, note = ""): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${paypalId}/cancel`, {
      json: { subject: "Payment request replaced", note: note.slice(0, 4000), send_to_invoicer: false, send_to_recipient: false },
    });
  }

  /** Record money received outside PayPal, such as a bank transfer. */
  async recordPayment(paypalId: string, amountCents: number, on: IsoDate, note = ""): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${paypalId}/payments`, {
      json: { method: "BANK_TRANSFER", payment_date: on, amount: { currency_code: "EUR", value: decimalText(amountCents) }, note: note.slice(0, 2000) },
    });
  }

  async findByNumber(number: string): Promise<string | null> {
    const response = await this.request("POST", "/v2/invoicing/search-invoices?page=1&page_size=1", { json: { invoice_number: number } });
    const items = ((await response.json()) as Json).items ?? [];
    return items.length ? items[0].id : null;
  }

  /** Ask PayPal whether this webhook call really came from PayPal. */
  async verifyWebhook(webhookId: string, headers: Record<string, string>, event: unknown): Promise<boolean> {
    const needed = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (!webhookId || needed.some((name) => !headers[name])) return false;
    try {
      const response = await this.request("POST", "/v1/notifications/verify-webhook-signature", {
        json: {
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: webhookId,
          webhook_event: event,
        },
      });
      return ((await response.json()) as Json).verification_status === "SUCCESS";
    } catch (error) {
      if (error instanceof PayPalError) return false;
      throw error;
    }
  }
}

interface SimInvoice {
  number: string;
  gross_cents: number;
  pay_link: string;
  status: string;
  paid_cents: number;
  transactions: { id: string; amount: number; on: string; method: string }[];
  reminders: { subject: string; note: string }[];
}

/** Behaves like the sandbox, but no network is used. It is shown clearly as simulated in the app. */
export class SimulatedPayPal implements PayPalApi {
  readonly simulated = true;
  failNext: PayPalError | null = null;
  readonly calls: string[] = [];
  private readonly invoices = new Map<string, SimInvoice>();

  constructor(private readonly store?: string) {
    if (store && existsSync(store)) {
      for (const [key, value] of Object.entries(JSON.parse(readFileSync(store, "utf8")) as Record<string, SimInvoice>)) this.invoices.set(key, value);
    }
  }

  private save(): void {
    if (!this.store) return;
    mkdirSync(dirname(this.store), { recursive: true });
    writeFileSync(this.store, JSON.stringify(Object.fromEntries(this.invoices)), "utf8");
  }

  private maybeFail(name: string): void {
    this.calls.push(name);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  private invoice(paypalId: string): SimInvoice {
    const invoice = this.invoices.get(paypalId);
    if (!invoice) throw new PayPalError("Simulated invoice not found", 404);
    return invoice;
  }

  async createInvoice(request: PaymentRequest): Promise<string> {
    this.maybeFail("create");
    for (const [key, invoice] of this.invoices) if (invoice.number === request.number) return key; // same result as the real client after a duplicate number
    let gross = 0;
    for (const line of request.lines) {
      const net = Math.floor(Number(line.quantity) * line.unit_price_cents + 0.5);
      const percent = Number(line.vat_percent || 0);
      gross += net + Math.floor((net * percent) / 100 + 0.5);
    }
    const key = `SIM-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    this.invoices.set(key, { number: request.number, gross_cents: gross, pay_link: `/simulated-paypal/${key}`, status: "DRAFT", paid_cents: 0, transactions: [], reminders: [] });
    this.save();
    return key;
  }

  async send(paypalId: string, _notifyCustomer = true): Promise<void> {
    this.maybeFail("send");
    this.invoice(paypalId).status = "SENT";
    this.save();
  }

  async get(paypalId: string): Promise<InvoiceState> {
    this.maybeFail("get");
    const invoice = this.invoice(paypalId);
    return {
      paypal_id: paypalId,
      status: invoice.status,
      paid_cents: invoice.paid_cents,
      due_cents: invoice.gross_cents - invoice.paid_cents,
      transactions: invoice.transactions.map((t) => ({ external_id: t.id, amount_cents: t.amount, paid_on: t.on, method: t.method })),
      pay_link: invoice.pay_link,
    };
  }

  async qrCode(): Promise<Buffer | null> {
    this.maybeFail("qr");
    return null;
  }

  async remind(paypalId: string, subject: string, note: string): Promise<void> {
    this.maybeFail("remind");
    this.invoice(paypalId).reminders.push({ subject, note });
    this.save();
  }

  async cancel(paypalId: string, _note = ""): Promise<void> {
    this.maybeFail("cancel");
    this.invoice(paypalId).status = "CANCELLED";
    this.save();
  }

  async recordPayment(paypalId: string, amountCents: number, on: IsoDate): Promise<void> {
    this.maybeFail("record_payment");
    this.pay(paypalId, amountCents, on);
  }

  async findByNumber(number: string): Promise<string | null> {
    for (const [key, invoice] of this.invoices) if (invoice.number === number) return key;
    return null;
  }

  async verifyWebhook(_webhookId: string, headers: Record<string, string>): Promise<boolean> {
    return headers["x-simulated-signature"] === "valid";
  }

  /** Only for the simulator: acts as the customer paying. */
  pay(paypalId: string, amountCents?: number, on?: IsoDate): void {
    const invoice = this.invoice(paypalId);
    const amount = amountCents ?? invoice.gross_cents - invoice.paid_cents;
    invoice.transactions.push({ id: `SIMPAY-${randomUUID().replaceAll("-", "").slice(0, 10)}`, amount, on: on ?? realToday(), method: "PAYPAL" });
    invoice.paid_cents += amount;
    invoice.status = invoice.paid_cents >= invoice.gross_cents ? "PAID" : "PARTIALLY_PAID";
    this.save();
  }

  reminders(paypalId: string): { subject: string; note: string }[] {
    return [...this.invoice(paypalId).reminders];
  }
}
