// Settings > Connections: the owner sets their own PayPal sandbox keys and local AI here, instead of in .env.
// The secret goes in and never comes out. Each save is written to the audit trail, without any key in it.
import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import * as audit from "../audit";
import { connectionOf, connectionsJson, forgetAi, forgetPaypal, saveAi, savePaypal } from "../connections";
import { PayPalClient, PayPalError } from "../paypal";
import { Secret, SANDBOX_URL } from "../settings";
import { ValidationFailed } from "./errors";
import { AiIn, AiTestIn, parse, PaypalIn, PaypalTestIn } from "./schemas";
import { Services } from "./services";

export type PaypalCheck = { ok: boolean; code: "ok" | "missing" | "refused" | "unreachable" | "error" };
export type AiCheck = { ok: boolean; code: "ok" | "off" | "unreachable" | "model_missing"; models: string[] };

@Controller("api/connections")
export class ConnectionsController {
  constructor(@Inject(Services) private readonly s: Services) {}

  private view() {
    return connectionsJson(this.s.base, connectionOf(this.s.db), this.s.vault);
  }

  @Get()
  get() {
    return this.view();
  }

  @Put("paypal")
  async putPaypal(@Body() body: unknown) {
    const input = parse(PaypalIn, body);
    if (!savePaypal(this.s.db, this.s.vault, this.s.base, input)) throw new ValidationFailed(["client_secret"]);
    audit.record(this.s.db, "owner", "connection_changed", null, { part: "paypal" });
    this.s.reconnect();
    const test = await this.checkPaypal(this.s.settings.paypalClientId, this.s.settings.paypalClientSecret.reveal());
    return { ...this.view(), test };
  }

  @Delete("paypal")
  deletePaypal() {
    forgetPaypal(this.s.db);
    audit.record(this.s.db, "owner", "connection_changed", null, { part: "paypal", removed: true });
    this.s.reconnect();
    return this.view();
  }

  /** Tests typed keys before saving them, or the keys in use when the boxes are empty. */
  @HttpCode(200)
  @Post("paypal/test")
  async testPaypal(@Body() body: unknown) {
    const input = parse(PaypalTestIn, body);
    return this.checkPaypal(input.client_id || this.s.settings.paypalClientId, input.client_secret || this.s.settings.paypalClientSecret.reveal());
  }

  @Put("ai")
  async putAi(@Body() body: unknown) {
    const input = parse(AiIn, body);
    saveAi(this.s.db, input);
    audit.record(this.s.db, "owner", "connection_changed", null, { part: "ai", enabled: input.enabled, model: input.model });
    this.s.reconnect();
    const test = input.enabled ? await this.checkAi(input.base_url, input.model) : { ok: true, code: "off" as const, models: [] };
    return { ...this.view(), test };
  }

  @Delete("ai")
  deleteAi() {
    forgetAi(this.s.db);
    audit.record(this.s.db, "owner", "connection_changed", null, { part: "ai", removed: true });
    this.s.reconnect();
    return this.view();
  }

  @HttpCode(200)
  @Post("ai/test")
  async testAi(@Body() body: unknown) {
    const input = parse(AiTestIn, body);
    return this.checkAi(input.base_url, "");
  }

  private async checkPaypal(clientId: string, secret: string): Promise<PaypalCheck> {
    if (!clientId || !secret) return { ok: false, code: "missing" };
    // Always the sandbox: this app never touches real money.
    const client = new PayPalClient({ baseUrl: SANDBOX_URL, clientId, clientSecret: new Secret(secret), fetch: this.s.http });
    try {
      await client.checkKeys();
      return { ok: true, code: "ok" };
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      if (error.status === 401 || error.status === 400 || error.status === 403) return { ok: false, code: "refused" };
      return { ok: false, code: error.status ? "error" : "unreachable" };
    }
  }

  /** Lists the models the local AI has, so the owner picks one instead of typing it. */
  private async checkAi(baseUrl: string, model: string): Promise<AiCheck> {
    let models: string[];
    try {
      const response = await this.s.http(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { ok: false, code: "unreachable", models: [] };
      const body = (await response.json()) as { models?: { name?: unknown }[] };
      models = (body.models ?? []).map((item) => item.name).filter((name): name is string => typeof name === "string").slice(0, 50);
    } catch {
      return { ok: false, code: "unreachable", models: [] };
    }
    if (model && !models.includes(model)) return { ok: false, code: "model_missing", models };
    return { ok: true, code: "ok", models };
  }
}
