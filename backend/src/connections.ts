// The owner's own keys, set in the app (Settings > Connections) instead of the .env file.
// One business per install. PayPal is sandbox only. The PayPal secret is stored sealed (AES-256-GCM)
// and is never sent back to the screens: they only learn that it is set and its last four characters.
//
// Honest limit: the sealing key lives in a file next to the database. A copy of the database alone
// does not reveal the secret, but someone who can read the whole data folder can. Keep the folder private.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Db } from "./db";
import { Secret, Settings } from "./settings";

export class Vault {
  private readonly key: Buffer;

  /** file: where the sealing key is kept. null keeps it in memory only (tests, in-memory databases). */
  constructor(file: string | null) {
    if (!file) {
      this.key = randomBytes(32);
      return;
    }
    if (existsSync(file)) {
      const saved = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      if (saved.length !== 32) throw new Error(`The key file ${file} is damaged. Move it away and enter the PayPal secret again.`);
      this.key = saved;
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    this.key = randomBytes(32);
    writeFileSync(file, this.key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  }

  seal(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  /** null when the value was sealed with another key (the key file was lost or replaced). */
  open(sealed: string): string | null {
    if (!sealed.startsWith("v1:")) return null;
    try {
      const raw = Buffer.from(sealed.slice(3), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

export interface Connection {
  id: number;
  paypal_saved: boolean;
  paypal_client_id: string;
  paypal_secret: string;
  paypal_secret_hint: string;
  paypal_webhook_id: string;
  sandbox_buyer_email: string;
  ai_saved: boolean;
  ai_enabled: boolean;
  ollama_base_url: string;
  ollama_model: string;
  ai_cpu_only: boolean;
  updated_at: string | null;
}

export function connectionOf(db: Db): Connection {
  const found = db.row("connection", `SELECT ${db.columns("connection")} FROM connection ORDER BY id LIMIT 1`);
  if (found) return found as Connection;
  const id = db.insert("connection", {});
  return db.get("connection", id) as Connection;
}

const hintOf = (secret: string): string => (secret.length >= 8 ? secret.slice(-4) : "");

/** The settings the app really uses: the .env values, with each group the owner saved in the app on top. */
export function effectiveSettings(base: Settings, row: Connection, vault: Vault): Settings {
  const out: Settings = { ...base };
  if (row.paypal_saved) {
    const secret = new Secret(vault.open(row.paypal_secret) ?? "");
    out.paypalClientId = row.paypal_client_id;
    out.paypalClientSecret = secret;
    out.paypalWebhookId = row.paypal_webhook_id;
    out.sandboxBuyerEmail = row.sandbox_buyer_email;
    out.hasPaypalKeys = Boolean(row.paypal_client_id && secret.isSet);
  }
  if (row.ai_saved) {
    out.ollamaBaseUrl = row.ollama_base_url || base.ollamaBaseUrl;
    out.ollamaModel = row.ai_enabled ? row.ollama_model : "";
    out.aiCpuOnly = row.ai_cpu_only;
  }
  return out;
}

export type Source = "app" | "env" | "none";

/** What the screens may see. Never the secret itself. */
export function connectionsJson(base: Settings, row: Connection, vault: Vault) {
  const envPaypal = Boolean(base.paypalClientId || base.paypalClientSecret.isSet);
  const envSecret = base.paypalClientSecret.reveal();
  const paypalSource: Source = row.paypal_saved ? "app" : envPaypal ? "env" : "none";
  const unreadable = row.paypal_saved && Boolean(row.paypal_secret) && vault.open(row.paypal_secret) === null;
  const paypal =
    paypalSource === "app"
      ? {
          client_id: row.paypal_client_id, secret_set: Boolean(row.paypal_secret) && !unreadable, secret_hint: unreadable ? "" : row.paypal_secret_hint,
          webhook_id: row.paypal_webhook_id, buyer_email: row.sandbox_buyer_email,
        }
      : {
          client_id: base.paypalClientId, secret_set: base.paypalClientSecret.isSet, secret_hint: hintOf(envSecret),
          webhook_id: base.paypalWebhookId, buyer_email: base.sandboxBuyerEmail,
        };
  const envAi = Boolean(base.ollamaModel);
  const aiSource: Source = row.ai_saved ? "app" : envAi ? "env" : "none";
  const ai =
    aiSource === "app"
      ? { enabled: row.ai_enabled, base_url: row.ollama_base_url || base.ollamaBaseUrl, model: row.ollama_model, cpu_only: row.ai_cpu_only }
      : { enabled: envAi, base_url: base.ollamaBaseUrl, model: base.ollamaModel, cpu_only: base.aiCpuOnly };
  return {
    paypal: { source: paypalSource, mode: "sandbox", secret_unreadable: unreadable, ...paypal },
    ai: { source: aiSource, ...ai },
    updated_at: row.updated_at,
  };
}

export interface PaypalInput {
  client_id: string;
  /** Empty keeps the secret already in use. */
  client_secret: string;
  webhook_id: string;
  buyer_email: string;
}

/** Returns false when there is no secret to keep and none was typed. */
export function savePaypal(db: Db, vault: Vault, base: Settings, input: PaypalInput): boolean {
  const row = connectionOf(db);
  let sealed: string;
  let hint: string;
  if (input.client_secret) {
    sealed = vault.seal(input.client_secret);
    hint = hintOf(input.client_secret);
  } else if (row.paypal_saved && row.paypal_secret && vault.open(row.paypal_secret) !== null) {
    sealed = row.paypal_secret;
    hint = row.paypal_secret_hint;
  } else if (!row.paypal_saved && base.paypalClientSecret.isSet) {
    // Moving from the .env file to the app: keep the same secret.
    sealed = vault.seal(base.paypalClientSecret.reveal());
    hint = hintOf(base.paypalClientSecret.reveal());
  } else {
    return false;
  }
  db.update("connection", row.id, {
    paypal_saved: true, paypal_client_id: input.client_id, paypal_secret: sealed, paypal_secret_hint: hint,
    paypal_webhook_id: input.webhook_id, sandbox_buyer_email: input.buyer_email, updated_at: new Date().toISOString(),
  });
  return true;
}

export function forgetPaypal(db: Db): void {
  const row = connectionOf(db);
  db.update("connection", row.id, {
    paypal_saved: false, paypal_client_id: "", paypal_secret: "", paypal_secret_hint: "", paypal_webhook_id: "", sandbox_buyer_email: "",
    updated_at: new Date().toISOString(),
  });
}

export interface AiInput {
  enabled: boolean;
  base_url: string;
  model: string;
  cpu_only: boolean;
}

export function saveAi(db: Db, input: AiInput): void {
  const row = connectionOf(db);
  db.update("connection", row.id, {
    ai_saved: true, ai_enabled: input.enabled, ollama_base_url: input.base_url, ollama_model: input.model, ai_cpu_only: input.cpu_only,
    updated_at: new Date().toISOString(),
  });
}

export function forgetAi(db: Db): void {
  const row = connectionOf(db);
  db.update("connection", row.id, { ai_saved: false, ai_enabled: true, ollama_base_url: "", ollama_model: "", ai_cpu_only: false, updated_at: new Date().toISOString() });
}
