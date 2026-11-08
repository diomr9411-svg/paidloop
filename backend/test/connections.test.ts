// Settings > Connections: owners set their own keys in the app. The secret goes in and never comes out.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Vault } from "../src/connections";
import { Services } from "../src/http/services";
import { loadSettings } from "../src/settings";

// Test keys only. Not real PayPal keys.
const GOOD_ID = "TestClientId_0001";
const GOOD_SECRET = "TestSecret_abcdefgh_WXYZ";
const ENV_SECRET = "EnvSecret_12345678_ENVS";

/** A pretend internet: PayPal accepts one pair of keys, and a local AI has one model. */
function fakeInternet(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/oauth2/token")) {
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      const pair = Buffer.from(auth.replace("Basic ", ""), "base64").toString("utf8");
      const ok = pair === `${GOOD_ID}:${GOOD_SECRET}` || pair === `${GOOD_ID}:${ENV_SECRET}`;
      return new Response(JSON.stringify(ok ? { access_token: "token", expires_in: 3600 } : { error: "invalid_client" }), { status: ok ? 200 : 401 });
    }
    if (url === "http://localhost:11434/api/tags") return new Response(JSON.stringify({ models: [{ name: "qwen2.5:3b" }, { name: "llama3.2:1b" }] }), { status: 200 });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
}

interface Setup {
  http: ReturnType<typeof request>;
  services: Services;
  dir: string;
  close(): Promise<void>;
}

const open: Setup[] = [];

async function start(env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), "paidloop-conn-"))): Promise<Setup> {
  const settings = loadSettings({ DATABASE_URL: `sqlite:///${dir.replaceAll("\\", "/")}/test.db`, SYNC_INTERVAL_SECONDS: "0", PUBLIC_BASE_URL: "http://localhost:8000", ...env }, join(dir, "no.env"));
  const { app, services } = await createApp({ settings, http: fakeInternet() });
  const setup: Setup = { http: request(app.getHttpServer()), services, dir, close: async () => { await app.close(); services.db.close(); } };
  open.push(setup);
  return setup;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe("the vault", () => {
  it("opens what it sealed, and nothing sealed with another key", () => {
    const dir = mkdtempSync(join(tmpdir(), "paidloop-vault-"));
    const vault = new Vault(join(dir, "secret.key"));
    const sealed = vault.seal(GOOD_SECRET);
    expect(sealed).not.toContain(GOOD_SECRET);
    expect(vault.open(sealed)).toBe(GOOD_SECRET);
    expect(new Vault(join(dir, "secret.key")).open(sealed)).toBe(GOOD_SECRET); // same key file after a restart
    expect(new Vault(null).open(sealed)).toBeNull();
    expect(vault.open(sealed.slice(0, -4) + "AAAA")).toBeNull(); // changed bytes are refused
  });
});

describe("connections", () => {
  it("starts with nothing set and the simulator", async () => {
    const { http, services } = await start();
    const body = (await http.get("/api/connections")).body;
    expect(body.paypal).toMatchObject({ source: "none", mode: "sandbox", secret_set: false });
    expect(body.ai.source).toBe("none");
    expect(services.paypal.simulated).toBe(true);
  });

  it("shows keys from .env without ever showing the secret", async () => {
    const { http } = await start({ PAYPAL_CLIENT_ID: GOOD_ID, PAYPAL_CLIENT_SECRET: ENV_SECRET });
    const response = await http.get("/api/connections");
    expect(response.body.paypal).toMatchObject({ source: "env", client_id: GOOD_ID, secret_set: true, secret_hint: "ENVS" });
    expect(response.text).not.toContain(ENV_SECRET);
  });

  it("saves PayPal keys, tests them, switches off the simulator, and keeps the secret sealed", async () => {
    const { http, services, dir } = await start();
    const response = await http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET, webhook_id: "WH-1", buyer_email: "buyer@example.com" });
    expect(response.status).toBe(200);
    expect(response.body.test).toEqual({ ok: true, code: "ok" });
    expect(response.body.paypal).toMatchObject({ source: "app", client_id: GOOD_ID, secret_set: true, secret_hint: "WXYZ", webhook_id: "WH-1" });
    expect(response.text).not.toContain(GOOD_SECRET);
    expect(services.paypal.simulated).toBe(false);
    expect(services.settings.paypalWebhookId).toBe("WH-1");
    expect(readFileSync(join(dir, "test.db")).includes(Buffer.from(GOOD_SECRET))).toBe(false);
    const auditText = JSON.stringify((await http.get("/api/audit")).body);
    expect(auditText).not.toContain(GOOD_SECRET);
    expect((await http.get("/api/health")).body).toMatchObject({ paypal_mode: "sandbox", paypal_keys_set: true });
  });

  it("says when PayPal refuses the keys, and still keeps what was typed", async () => {
    const { http } = await start();
    const response = await http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: "WrongSecret_00000000" });
    expect(response.body.test).toEqual({ ok: false, code: "refused" });
    expect(response.body.paypal.source).toBe("app");
  });

  it("tests typed keys before saving, without changing anything", async () => {
    const { http, services } = await start();
    expect((await http.post("/api/connections/paypal/test").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET })).body).toEqual({ ok: true, code: "ok" });
    expect((await http.post("/api/connections/paypal/test").send({})).body).toEqual({ ok: false, code: "missing" });
    expect(services.paypal.simulated).toBe(true);
  });

  it("needs a secret the first time, then an empty box keeps it", async () => {
    const { http } = await start();
    const first = await http.put("/api/connections/paypal").send({ client_id: GOOD_ID });
    expect(first.status).toBe(422);
    expect(first.body.fields).toEqual(["client_secret"]);
    await http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET });
    const again = await http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: "", webhook_id: "WH-2" });
    expect(again.body.test.ok).toBe(true);
    expect(again.body.paypal).toMatchObject({ secret_hint: "WXYZ", webhook_id: "WH-2" });
  });

  it("moves the secret from .env into the app when the box is left empty", async () => {
    const { http } = await start({ PAYPAL_CLIENT_ID: GOOD_ID, PAYPAL_CLIENT_SECRET: ENV_SECRET });
    const response = await http.put("/api/connections/paypal").send({ client_id: GOOD_ID });
    expect(response.body.paypal).toMatchObject({ source: "app", secret_hint: "ENVS" });
    expect(response.body.test.ok).toBe(true);
  });

  it("refuses bad input", async () => {
    const { http } = await start();
    const response = await http.put("/api/connections/paypal").send({ client_id: "short", client_secret: "has spaces in it", buyer_email: "not-an-email" });
    expect(response.status).toBe(422);
    expect(response.body.fields).toEqual(expect.arrayContaining(["client_id", "client_secret", "buyer_email"]));
  });

  it("keeps the keys after a demo reset and after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paidloop-conn-"));
    const first = await start({}, dir);
    await first.http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET });
    await first.services.db.dropAll(); // what the demo reset does to the tables
    expect((await first.http.get("/api/connections")).body.paypal.source).toBe("app");
    await first.close();
    open.splice(open.indexOf(first), 1);

    const second = await start({}, dir);
    expect(second.services.settings.paypalClientSecret.reveal()).toBe(GOOD_SECRET);
    expect(second.services.paypal.simulated).toBe(false);
  });

  it("forgetting the keys goes back to .env, or to the simulator", async () => {
    const { http, services } = await start();
    await http.put("/api/connections/paypal").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET });
    const response = await http.delete("/api/connections/paypal");
    expect(response.body.paypal.source).toBe("none");
    expect(services.paypal.simulated).toBe(true);
  });

  it("lists the local AI models, and checks the chosen one", async () => {
    const { http, services } = await start();
    expect((await http.post("/api/connections/ai/test").send({ base_url: "http://localhost:11434" })).body).toEqual({ ok: true, code: "ok", models: ["qwen2.5:3b", "llama3.2:1b"] });
    expect((await http.post("/api/connections/ai/test").send({ base_url: "http://localhost:9" })).body.code).toBe("unreachable");

    const saved = await http.put("/api/connections/ai").send({ enabled: true, base_url: "http://localhost:11434", model: "qwen2.5:3b" });
    expect(saved.body.test.code).toBe("ok");
    expect(saved.body.ai).toMatchObject({ source: "app", enabled: true, model: "qwen2.5:3b" });
    expect(services.settings.ollamaModel).toBe("qwen2.5:3b");

    const missing = await http.put("/api/connections/ai").send({ enabled: true, base_url: "http://localhost:11434", model: "other:7b" });
    expect(missing.body.test.code).toBe("model_missing");

    const off = await http.put("/api/connections/ai").send({ enabled: false });
    expect(off.body.ai.enabled).toBe(false);
    expect(services.settings.ollamaModel).toBe("");
  });

  it("needs a model when the AI is on, and a web address", async () => {
    const { http } = await start();
    expect((await http.put("/api/connections/ai").send({ enabled: true, model: "" })).body.fields).toEqual(["model"]);
    expect((await http.put("/api/connections/ai").send({ enabled: true, model: "x", base_url: "file:///etc/passwd" })).body.fields).toEqual(["base_url"]);
  });
});

describe("only this computer may use the app", () => {
  it("refuses another host name and changes sent from other websites", async () => {
    const { http } = await start();
    expect((await http.get("/api/connections").set("Host", "evil.example")).status).toBe(403);
    expect((await http.put("/api/connections/paypal").set("Origin", "https://evil.example").send({ client_id: GOOD_ID, client_secret: GOOD_SECRET })).status).toBe(403);
    expect((await http.post("/api/connections/ai/test").set("Origin", "http://localhost:5173").send({})).status).toBe(200);
    expect((await http.get("/api/health").set("Origin", "https://evil.example")).status).toBe(200); // reading is blocked by the browser itself
  });
});
