// What every route needs: the database, PayPal, the AI and the settings. Built at start, and built again
// when the owner saves new connections in the app.
import { dirname, join, resolve } from "node:path";
import { AI, LocalAI, NoAI } from "../ai";
import { connectionOf, effectiveSettings, Vault } from "../connections";
import { Db } from "../db";
import * as invoices from "../invoices";
import { PayPalApi, PayPalClient, PayPalError, SimulatedPayPal } from "../paypal";
import { Settings, REPO_ROOT } from "../settings";
import { OPEN_STATES } from "../states";
import { getInvoice } from "../repo";

export interface Builders {
  paypal(settings: Settings): PayPalApi;
  ai(settings: Settings): AI;
}

export interface ServiceExtras {
  /** The settings from the environment and .env, before the owner's saved connections. */
  base?: Settings;
  vault?: Vault;
  builders?: Builders;
  /** Used to test keys. Tests swap it. */
  http?: typeof fetch;
}

export class Services {
  readonly publicBase: string;
  readonly base: Settings;
  readonly vault: Vault;
  readonly http: typeof fetch;
  readonly syncState: { last_ok_at: string | null; last_error: string | null } = { last_ok_at: null, last_error: null };
  private readonly builders: Builders;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(readonly db: Db, public paypal: PayPalApi, public ai: AI, public settings: Settings, extras: ServiceExtras = {}) {
    this.publicBase = settings.publicBaseUrl.replace(/\/+$/, "");
    this.base = extras.base ?? settings;
    this.vault = extras.vault ?? new Vault(null);
    this.http = extras.http ?? fetch;
    this.builders = extras.builders ?? { paypal: () => paypal, ai: () => ai };
  }

  /** After the owner saves new keys: work out the settings again and build new PayPal and AI clients. */
  reconnect(): void {
    this.settings = effectiveSettings(this.base, connectionOf(this.db), this.vault);
    this.paypal = this.builders.paypal(this.settings);
    this.ai = this.builders.ai(this.settings);
    // The light shows the new connection, not an error from the old one.
    this.syncState.last_ok_at = null;
    this.syncState.last_error = null;
  }

  /** Payment updates work without a public webhook address, because the app asks PayPal itself. */
  startSync(): void {
    if (this.timer || this.settings.syncIntervalSeconds <= 0) return;
    this.timer = setInterval(() => void this.syncOnce(), this.settings.syncIntervalSeconds * 1000);
    this.timer.unref();
  }

  stopSync(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncOnce(): Promise<void> {
    if (this.running) return; // a slow round must not pile up behind itself
    this.running = true;
    const paypal = this.paypal;
    let problem: string | null = null;
    try {
      const ids = this.db.query(`SELECT id FROM invoice WHERE status IN (${OPEN_STATES.map(() => "?").join(",")})`, ...OPEN_STATES).map((row) => row.id as number);
      for (const id of ids) {
        const invoice = getInvoice(this.db, id);
        if (!invoice) continue;
        try {
          await invoices.sync(this.db, invoice, paypal);
        } catch (error) {
          if (!(error instanceof PayPalError)) throw error;
          problem = error.message.slice(0, 200);
        }
      }
    } catch (error) {
      console.error("Payment sync failed", error); // keep the loop alive; the next round tries again
      problem = (error as Error).name;
    } finally {
      this.running = false;
    }
    if (paypal !== this.paypal) return; // the owner changed the keys during this round; its answer is old news
    // The owner sees this as a status light, so a silent failure can't pass unnoticed.
    if (problem) this.syncState.last_error = problem;
    else {
      this.syncState.last_ok_at = new Date().toISOString().slice(0, 19) + "+00:00";
      this.syncState.last_error = null;
    }
  }
}

/** dataDir: where the simulator keeps its invoices. null keeps them in memory. */
export function buildPaypal(settings: Settings, dataDir: string | null = resolve(REPO_ROOT, "data"), http?: typeof fetch): PayPalApi {
  if (settings.hasPaypalKeys) {
    return new PayPalClient({ baseUrl: settings.paypalBaseUrl, clientId: settings.paypalClientId, clientSecret: settings.paypalClientSecret, fetch: http });
  }
  return new SimulatedPayPal(dataDir ? join(dataDir, "simulated_paypal.json") : undefined);
}

export function buildAi(settings: Settings, dataDir: string | null = resolve(REPO_ROOT, "data"), http?: typeof fetch): AI {
  if (!settings.ollamaModel) return new NoAI();
  return new LocalAI({
    baseUrl: settings.ollamaBaseUrl, model: settings.ollamaModel, timeoutSeconds: settings.aiTimeoutSeconds,
    answersFile: dataDir ? join(dataDir, "ai_answers.json") : undefined, cpuOnly: settings.aiCpuOnly, fetch: http,
    visionModel: settings.ollamaVisionModel,
  });
}

/** The folder of the database file, or null for an in-memory database. */
export const dataDirOf = (db: Db): string | null => (db.path === ":memory:" ? null : dirname(db.path));
