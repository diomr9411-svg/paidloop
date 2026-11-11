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
  /** Writes down the text in a photo with a local vision model. null if there is no such model, or it failed. */
  readImage?(image: Uint8Array, prompt: string, timeoutSeconds?: number): Promise<string | null>;
  /** The installed model that can read photos, or "" if there is none. */
  visionModel?(): Promise<string>;
}

/** Ollama streams one JSON object per line. The answer is the joined message content (thinking is left out). */
async function streamedContent(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let rest = "";
  const take = (line: string) => {
    if (!line.trim()) return;
    const part = JSON.parse(line) as { message?: { content?: string }; error?: string };
    if (part.error) throw new Error(part.error);
    content += part.message?.content ?? "";
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(take);
  }
  take(rest + decoder.decode());
  return content;
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
  /** The model for photos. Empty: the main model if it can see, else the first installed model that can. */
  visionModel?: string;
  /** For tests */
  fetch?: typeof fetch;
}

// A 1280-pixel photo is about 1,300 tokens. A "thinking" model writes its thoughts before the answer, so the
// answer gets room for both. A short note's text alone is about 50 tokens.
const PHOTO_CONTEXT = 4096;
const PHOTO_ANSWER_TOKENS = 1500;
// The photo model is big. On a 16 GB laptop, it and the text model must not sit in memory together.
const PHOTO_KEEP_ALIVE = 0;

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
  private readonly visionChoice: string;
  private vision = { name: "", at: 0 };

  constructor(options: LocalAIOptions) {
    this.model = options.model;
    this.visionChoice = options.visionModel ?? "";
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

  /** Ollama says which installed models can see. The answer is kept for a minute. */
  async visionModel(): Promise<string> {
    if (Date.now() - this.vision.at < 60_000) return this.vision.name;
    let name = "";
    try {
      const tags = await this.http(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const installed = ((await tags.json()) as { models?: { name?: string }[] }).models?.map((item) => item.name ?? "") ?? [];
      // A model that answers at once ("instruct") is faster on a laptop than one that thinks first
      const others = installed.filter((item) => item !== this.model).sort((a, b) => Number(/instruct/i.test(b)) - Number(/instruct/i.test(a)));
      const candidates = this.visionChoice ? [this.visionChoice] : [this.model, ...others];
      for (const candidate of candidates.filter((item) => item && installed.includes(item))) {
        const show = await this.http(`${this.baseUrl}/api/show`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: candidate }), signal: AbortSignal.timeout(5000),
        });
        const capabilities = show.ok ? ((await show.json()) as { capabilities?: string[] }).capabilities ?? [] : [];
        if (capabilities.includes("vision")) {
          name = candidate;
          break;
        }
      }
    } catch {
      name = "";
    }
    this.vision = { name, at: Date.now() };
    return name;
  }

  async readImage(image: Uint8Array, prompt: string, timeoutSeconds?: number): Promise<string | null> {
    const model = await this.visionModel();
    if (!model) return null;
    const picture = createHash("sha256").update(image).digest("hex");
    const key = createHash("sha256").update(JSON.stringify([model, prompt, picture, "photo"]), "utf8").digest("hex");
    if (this.answers[key] !== undefined) return this.answers[key];
    if (model !== this.model) await this.unload(this.model);
    // Streamed, so a long answer is not cut off by the 5-minute wait limit of Node's fetch
    const body = {
      model,
      stream: true,
      think: false,
      keep_alive: PHOTO_KEEP_ALIVE,
      options: { ...this.options, num_ctx: PHOTO_CONTEXT, num_predict: PHOTO_ANSWER_TOKENS },
      messages: [{ role: "user", content: prompt, images: [Buffer.from(image).toString("base64")] }],
    };
    try {
      const response = await this.http(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((timeoutSeconds ?? this.timeoutSeconds) * 1000),
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const content = (await streamedContent(response.body)).trim();
      if (!content) return null;
      this.remember(key, content);
      return content;
    } catch (error) {
      console.warn(`Photo was not read by the AI: ${(error as Error).name}`);
      return null;
    }
  }

  /** Asks Ollama to free a model's memory now. It loads again by itself the next time it is needed. */
  private async unload(model: string): Promise<void> {
    try {
      await this.http(`${this.baseUrl}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Not being able to free memory early is no reason to stop
    }
  }
}
