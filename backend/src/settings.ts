// App settings, read from environment variables and the local .env file at the repo root.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const SANDBOX_URL = "https://api-m.sandbox.paypal.com";

/** A secret that never prints itself by accident (logs, JSON, error messages). */
export class Secret {
  constructor(private readonly value: string) {}
  reveal(): string {
    return this.value;
  }
  get isSet(): boolean {
    return this.value.length > 0;
  }
  toString(): string {
    return this.value ? "***" : "";
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${this.toString()})`;
  }
}

export interface Settings {
  paypalClientId: string;
  paypalClientSecret: Secret;
  paypalBaseUrl: string;
  paypalWebhookId: string;
  /** Test customers receive sandbox notices at this address. It must be a sandbox personal account. */
  sandboxBuyerEmail: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiTimeoutSeconds: number;
  aiCpuOnly: boolean;
  databaseUrl: string;
  syncIntervalSeconds: number;
  publicBaseUrl: string;
  hasPaypalKeys: boolean;
}

/** Reads KEY=VALUE lines. Quotes around a value are removed. Lines starting with # are comments. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1].toUpperCase()] = value;
  }
  return out;
}

const truthy = (value: string | undefined): boolean => ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());

export function loadSettings(env: Record<string, string | undefined> = process.env, envFile = resolve(REPO_ROOT, ".env")): Settings {
  // Real environment variables win over the .env file
  const fromFile = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const read = (name: string, fallback = ""): string => env[name] ?? fromFile[name] ?? fallback;

  const baseUrl = read("PAYPAL_BASE_URL", SANDBOX_URL).replace(/\/+$/, "");
  // This project never touches real money, so live PayPal is refused.
  if (baseUrl !== SANDBOX_URL) throw new Error(`PAYPAL_BASE_URL must be ${SANDBOX_URL}`);

  const secret = new Secret(read("PAYPAL_CLIENT_SECRET"));
  const clientId = read("PAYPAL_CLIENT_ID");
  return {
    paypalClientId: clientId,
    paypalClientSecret: secret,
    paypalBaseUrl: baseUrl,
    paypalWebhookId: read("PAYPAL_WEBHOOK_ID"),
    sandboxBuyerEmail: read("SANDBOX_BUYER_EMAIL"),
    ollamaBaseUrl: read("OLLAMA_BASE_URL", "http://localhost:11434"),
    ollamaModel: read("OLLAMA_MODEL"),
    aiTimeoutSeconds: Number(read("AI_TIMEOUT_SECONDS", "180")),
    aiCpuOnly: truthy(read("AI_CPU_ONLY")),
    databaseUrl: read("DATABASE_URL", "sqlite:///data/paidloop.db"),
    syncIntervalSeconds: Number(read("SYNC_INTERVAL_SECONDS", "20")),
    publicBaseUrl: read("PUBLIC_BASE_URL", "http://localhost:8000"),
    hasPaypalKeys: Boolean(clientId && secret.isSet),
  };
}
