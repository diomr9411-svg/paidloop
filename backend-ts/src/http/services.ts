// What every route needs: the database, PayPal, the AI and the settings. Built once at start.
import { resolve } from "node:path";
import { AI, LocalAI, NoAI } from "../ai";
import { Db } from "../db";
import * as invoices from "../invoices";
import { PayPalApi, PayPalClient, PayPalError, SimulatedPayPal } from "../paypal";
import { Settings, REPO_ROOT } from "../settings";
import { OPEN_STATES } from "../states";
import { getInvoice } from "../repo";

export class Services {
  readonly publicBase: string;
  readonly syncState: { last_ok_at: string | null; last_error: string | null } = { last_ok_at: null, last_error: null };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(readonly db: Db, readonly paypal: PayPalApi, readonly ai: AI, readonly settings: Settings) {
    this.publicBase = settings.publicBaseUrl.replace(/\/+$/, "");
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
    let problem: string | null = null;
    try {
      const ids = this.db.query(`SELECT id FROM invoice WHERE status IN (${OPEN_STATES.map(() => "?").join(",")})`, ...OPEN_STATES).map((row) => row.id as number);
      for (const id of ids) {
        const invoice = getInvoice(this.db, id);
        if (!invoice) continue;
        try {
          await invoices.sync(this.db, invoice, this.paypal);
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
    // The owner sees this as a status light, so a silent failure can't pass unnoticed.
    if (problem) this.syncState.last_error = problem;
    else {
      this.syncState.last_ok_at = new Date().toISOString().slice(0, 19) + "+00:00";
      this.syncState.last_error = null;
    }
  }
}

export function buildPaypal(settings: Settings): PayPalApi {
  if (settings.hasPaypalKeys) {
    return new PayPalClient({ baseUrl: settings.paypalBaseUrl, clientId: settings.paypalClientId, clientSecret: settings.paypalClientSecret });
  }
  return new SimulatedPayPal(resolve(REPO_ROOT, "data", "simulated_paypal.json"));
}

export function buildAi(settings: Settings): AI {
  if (!settings.ollamaModel) return new NoAI();
  return new LocalAI({
    baseUrl: settings.ollamaBaseUrl, model: settings.ollamaModel, timeoutSeconds: settings.aiTimeoutSeconds,
    answersFile: resolve(REPO_ROOT, "data", "ai_answers.json"), cpuOnly: settings.aiCpuOnly,
  });
}
