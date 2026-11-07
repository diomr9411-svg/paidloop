// Calendar dates are plain text "YYYY-MM-DD", so they sort correctly, store as text and have no time zone.
export type IsoDate = string;

const DAY_MS = 86_400_000;

export function parseDate(value: IsoDate): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error(`Not a date: ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return formatDate(parseDate(value) + days * DAY_MS);
}

/** Whole days from b to a (a - b). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parseDate(a) - parseDate(b)) / DAY_MS);
}

/** Calendar month arithmetic that clamps to the end of a shorter month (31 Jan + 1 month = 28 Feb). */
export function addMonths(value: IsoDate, months: number): IsoDate {
  const ms = parseDate(value);
  const date = new Date(ms);
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return formatDate(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/** The real calendar day on this computer (the demo clock adds its offset on top, see invoices). */
export function realToday(): IsoDate {
  const now = new Date();
  return formatDate(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** German format 07.11.2026 for messages and PDFs. */
export function germanDate(value: IsoDate): string {
  return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return formatDate(parseDate(value)) === value;
}
