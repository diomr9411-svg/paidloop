// Free local AI through Ollama. If it is slow, off or wrong, the app falls back to fixed rules.
//
// Nothing the AI returns is trusted. It must fit a schema, and code checks it before anything happens.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";

/** The shape an AI answer must have. The name is part of the cache key. */
export interface AiSchema<T> {
  name: string;
  zod: z.ZodType<T>;
}

export const aiSchema = <T>(name: string, zod: z.ZodType<T>): AiSchema<T> => ({ name, zod });

export interface AiStatus {
  available: boolean;
  model: string;
}

export interface AI {
  askJson<T>(system: string, user: string, schema: AiSchema<T>, timeoutSeconds?: number): Promise<T | null>;
  status(): Promise<AiStatus>;
}

/** Used when no local model is available. Every caller already has a rules fallback. */
export class NoAI implements AI {
  async askJson<T>(): Promise<T | null> {
    return null;
  }
  async status(): Promise<AiStatus> {
    return { available: false, model: "" };
  }
}

export interface LocalAIOptions {
  baseUrl: string;
  model: string;
  timeoutSeconds?: number;
  answersFile?: string;
  cpuOnly?: boolean;
  /** For tests */
  fetch?: typeof fetch;
}

export class LocalAI implements AI {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly options: Record<string, number>;
  private readonly answersFile?: string;
  private readonly http: typeof fetch;
  private answers: Record<string, string> = {};
  private cached: AiStatus;
  private cachedAt = 0;

  constructor(options: LocalAIOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutSeconds = options.timeoutSeconds ?? 180;
    this.http = options.fetch ?? fetch;
    // A small graphics card can make a model slower than the processor alone. We measured 2 vs 8 tokens a second.
    this.options = { temperature: 0, num_ctx: 2048, num_predict: 400 };
    if (options.cpuOnly) Object.assign(this.options, { num_gpu: 0, num_thread: Math.max(cpus().length - 2, 2) });
    this.answersFile = options.answersFile;
    this.cached = { available: false, model: options.model };
    if (this.answersFile && existsSync(this.answersFile)) {
      try {
        this.answers = JSON.parse(readFileSync(this.answersFile, "utf8"));
      } catch {
        this.answers = {};
      }
    }
  }

  /** Is the model ready? The result is kept for 20 seconds so screens stay fast. */
  async status(): Promise<AiStatus> {
    if (!this.model) return { available: false, model: "" };
    if (Date.now() - this.cachedAt < 20_000) return this.cached;
    let available = false;
    try {
      const response = await this.http(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const body = (await response.json()) as { models?: { name?: string }[] };
      available = response.ok && (body.models ?? []).some((item) => item.name === this.model);
    } catch {
      available = false;
    }
    this.cached = { available, model: this.model };
    this.cachedAt = Date.now();
    return this.cached;
  }

  private key(system: string, user: string, schemaName: string): string {
    return createHash("sha256").update(JSON.stringify([this.model, system, user, schemaName]), "utf8").digest("hex");
  }

  private remember(key: string, content: string): void {
    this.answers[key] = content;
    if (!this.answersFile) return;
    mkdirSync(dirname(this.answersFile), { recursive: true });
    writeFileSync(this.answersFile, JSON.stringify(this.answers), "utf8");
  }

  private parse<T>(schema: AiSchema<T>, content: string): T | null {
    try {
      const result = schema.zod.safeParse(JSON.parse(content));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  async askJson<T>(system: string, user: string, schema: AiSchema<T>, timeoutSeconds?: number): Promise<T | null> {
    const key = this.key(system, user, schema.name);
    const saved = this.answers[key];
    if (saved !== undefined) {
      const result = this.parse(schema, saved);
      if (result !== null) return result;
    }
    if (!(await this.status()).available) return null;
    const body = {
      model: this.model,
      stream: false,
      format: z.toJSONSchema(schema.zod),
      keep_alive: "20m",
      options: this.options,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    try {
      const response = await this.http(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((timeoutSeconds ?? this.timeoutSeconds) * 1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = ((await response.json()) as { message: { content: string } }).message.content;
      const result = this.parse(schema, content);
      if (result === null) throw new Error("answer does not fit the schema");
      this.remember(key, content);
      return result;
    } catch (error) {
      console.warn(`AI answer was not usable: ${(error as Error).name}`);
      return null;
    }
  }
}
