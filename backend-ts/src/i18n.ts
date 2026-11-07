// Two languages for everything the app says. A Text carries the English and the German.

export type Language = "en" | "de";
export const LANGUAGES: readonly Language[] = ["en", "de"];

export class Text {
  readonly en: string;
  readonly de: string;

  constructor(en: string, de?: string) {
    this.en = en;
    this.de = de ?? en;
  }

  get(language: Language | string): string {
    return language === "de" ? this.de : this.en;
  }

  toString(): string {
    return this.en;
  }

  toJSON(): string {
    return this.en;
  }
}

/** Shortcut: t("English", "Deutsch"). */
export const t = (en: string, de?: string): Text => new Text(en, de);

export function pick(value: unknown, language: Language | string): string {
  return value instanceof Text ? value.get(language) : String(value);
}

/** Accepts "de", "en" or a browser value such as "de-DE,de;q=0.9". */
export function languageFromHeader(value: string | null | undefined): Language {
  const code = (value ?? "").split(",")[0].split("-")[0].trim().toLowerCase();
  return code === "de" || code === "en" ? code : "en";
}

/** A problem the person can understand and fix, in their own language. */
export class LocalizedError extends Error {
  readonly text: Text;
  readonly status: number;

  constructor(text: Text | string, status = 422) {
    const value = text instanceof Text ? text : new Text(text);
    super(value.en);
    this.text = value;
    this.status = status;
  }

  localized(language: Language | string): string {
    return this.text.get(language);
  }
}
