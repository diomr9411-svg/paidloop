export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: isForm ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = `Something went wrong (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      else if (Array.isArray(body.detail)) message = "Please check the values you entered.";
    } catch {
      /* keep the plain message */
    }
    throw new ApiError(message, response.status);
  }
  return response.json();
}

export const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const moneyDe = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

export const eur = (cents: number) => money.format((cents || 0) / 100);
export const eurFor = (cents: number, language: string) => (language === "de" ? moneyDe : money).format((cents || 0) / 100);

export function day(iso?: string | null): string {
  if (!iso) return "-";
  const [year, month, date] = iso.slice(0, 10).split("-");
  return `${date}.${month}.${year}`;
}

export function addDays(iso: string, days: number): string {
  const value = new Date(`${iso}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  checked: "Checked",
  issued: "Open",
  on_plan: "On plan",
  disputed: "On hold",
  paid: "Paid",
  cancelled: "Cancelled",
};

export const ACTION_LABEL: Record<string, string> = {
  wait: "Wait",
  pre_due_note: "Note before the due date",
  friendly_reminder: "Friendly reminder",
  firm_reminder: "Formal reminder",
  final_notice: "Final reminder",
  owner_review: "Your decision needed",
  plan_exception: "Customer asks for your decision",
  dispute_review: "Customer raised a problem",
  payment_check: "Customer says they paid",
};
