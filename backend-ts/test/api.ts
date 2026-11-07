// A real app on a real database file, called over HTTP, like the Python TestClient.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { AI, NoAI } from "../src/ai";
import { createApp } from "../src/app";
import { addDays, realToday } from "../src/dates";
import { Services } from "../src/http/services";
import { SimulatedPayPal } from "../src/paypal";
import { loadSettings } from "../src/settings";

export interface Api {
  http: ReturnType<typeof request>;
  paypal: SimulatedPayPal;
  services: Services;
  get(path: string, headers?: Record<string, string>): request.Test;
  post(path: string, body?: unknown, headers?: Record<string, string>): request.Test;
  put(path: string, body?: unknown, headers?: Record<string, string>): request.Test;
  delete(path: string, headers?: Record<string, string>): request.Test;
  close(): Promise<void>;
}

export async function makeApi(options: { env?: Record<string, string>; ai?: AI; paypal?: SimulatedPayPal; setup?: boolean } = {}): Promise<Api> {
  const dir = mkdtempSync(join(tmpdir(), "paidloop-api-"));
  const env = {
    DATABASE_URL: `sqlite:///${dir.replaceAll("\\", "/")}/test.db`, SYNC_INTERVAL_SECONDS: "0", PUBLIC_BASE_URL: "http://test", PAYPAL_WEBHOOK_ID: "WH-1",
    ...options.env,
  };
  const paypal = options.paypal ?? new SimulatedPayPal();
  const { app, services } = await createApp({ settings: loadSettings(env, join(dir, "no.env")), paypal, ai: options.ai ?? new NoAI() });
  const http = request(app.getHttpServer());
  const api: Api = {
    http, paypal, services,
    get: (path, headers = {}) => http.get(path).set(headers),
    post: (path, body, headers = {}) => (body === undefined ? http.post(path).set(headers) : http.post(path).set(headers).send(body as object)),
    put: (path, body, headers = {}) => http.put(path).set(headers).send(body as object),
    delete: (path, headers = {}) => http.delete(path).set(headers),
    close: async () => { await app.close(); services.db.close(); },
  };
  if (options.setup !== false) {
    await api.put("/api/business", {
      name: "Beispiel Elektro GmbH", street: "Musterstraße 1", postcode: "32657", city: "Lemgo", vat_id: "DE000000000",
    });
  }
  return api;
}

export async function createIssued(api: Api, name = "Kunde GmbH", isBusiness = true): Promise<any> {
  const customer = (await api.post("/api/customers", { name, street: "Weg 1", postcode: "32756", city: "Detmold", email: "k@example.com", is_business: isBusiness })).body;
  const today = realToday();
  const draft = (await api.post("/api/invoices", {
    customer_id: customer.id,
    lines: [
      { description: "Reparatur", quantity: 4, unit: "HUR", unit_price_eur: 65, vat_percent: 19 },
      { description: "Material", quantity: 1, unit: "H87", unit_price_eur: 120, vat_percent: 19 },
    ],
    issue_date: today, service_date: today, due_date: addDays(today, 14),
  })).body;
  const check = await api.post(`/api/invoices/${draft.id}/check`);
  if (check.body.can_issue !== true) throw new Error(`Check failed: ${JSON.stringify(check.body)}`);
  const issued = await api.post(`/api/invoices/${draft.id}/issue`);
  if (issued.status !== 200) throw new Error(`Issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  return issued.body;
}
