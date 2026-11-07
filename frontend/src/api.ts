let language = "en";

/** Every request tells the server which language to answer in. */
export function setApiLanguage(value: string) {
  language = value;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public fields: string[] = []) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const headers: Record<string, string> = { "X-Language": language };
  if (!isForm) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers: { ...headers, ...((options.headers as Record<string, string>) || {}) } });
  } catch {
    throw new ApiError(language === "de" ? "Keine Verbindung zu PaidLoop. Läuft die App noch?" : "No connection to PaidLoop. Is the app still running?", 0);
  }
  if (!response.ok) {
    let message = language === "de" ? `Etwas ist schiefgelaufen (${response.status}).` : `Something went wrong (${response.status}).`;
    let fields: string[] = [];
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      if (Array.isArray(body.fields)) fields = body.fields;
    } catch {
      /* keep the plain message */
    }
    throw new ApiError(message, response.status, fields);
  }
  return response.json();
}

export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

export function addDays(iso: string, days: number): string {
  const [year, month, date] = iso.slice(0, 10).split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, date + days));
  return value.toISOString().slice(0, 10);
}

/** Reads what people type: 1234.5, 1234,5, 1.234,50 or 1,234.50. The screen shows the result right away. */
export function toNumber(text: string, lang: string): number {
  const value = String(text ?? "").trim().replace(/\s/g, "");
  if (!value) return 0;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  let normal = value;
  if (lastComma >= 0 && lastDot >= 0) {
    normal = lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normal = lang === "en" && /^\d{1,3}(,\d{3})+$/.test(value) ? value.replace(/,/g, "") : value.replace(",", ".");
  } else if (lang === "de" && /^\d{1,3}(\.\d{3})+$/.test(value)) {
    normal = value.replace(/\./g, "");
  }
  const number = Number(normal);
  return Number.isFinite(number) ? number : 0;
}

/** A number as text for an input field, with the decimal mark people expect. */
export function numberText(value: number | null | undefined, lang: string): string {
  if (value === null || value === undefined) return "";
  return lang === "de" ? String(value).replace(".", ",") : String(value);
}

// The same rounding as the server: half up, per line and per VAT rate.
export const lineNetCents = (quantity: number, price: number) =>
  Math.floor((Math.round(quantity * 1000) * Math.round(price * 100) + 500) / 1000);

export function totals(items: { net: number; vatPercent: number }[]) {
  const byRate = new Map<number, number>();
  for (const item of items) byRate.set(item.vatPercent, (byRate.get(item.vatPercent) || 0) + item.net);
  let net = 0;
  let vat = 0;
  byRate.forEach((rateNet, percent) => {
    net += rateNet;
    vat += Math.floor((rateNet * Math.round(percent * 100) + 5000) / 10000);
  });
  return { net, vat, gross: net + vat };
}

export function customerLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/pay/${token}`;
}
