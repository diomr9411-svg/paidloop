// A simple, explainable late-payment score from clear rules. This is not machine learning.
import { t, Text } from "./i18n";

export interface RiskInput {
  paid_count: number;
  avg_days_late: number;
  unpaid_count: number;
  days_overdue_now: number;
  open_cents: number;
}

export interface Risk {
  score: number;
  level: "low" | "medium" | "high";
  expected_days_late: number;
  reasons: Text[];
}

const days = (count: number): Text => t(count === 1 ? "1 day" : `${count} days`, count === 1 ? "1 Tag" : `${count} Tage`);

export function assess(data: RiskInput): Risk {
  let score = 25;
  const reasons: Text[] = [];

  if (data.paid_count === 0 && data.unpaid_count === 0) {
    score += 15; // an unknown customer is not the same as a reliable one
    reasons.push(t("No payment history yet.", "Noch keine Zahlungshistorie."));
  } else if (data.avg_days_late <= 3 && data.unpaid_count === 0) {
    score -= 15;
    const late = days(data.avg_days_late);
    reasons.push(t(`Pays on time: ${late.en} late on average over ${data.paid_count} invoices.`,
      `Zahlt zuverlässig: im Schnitt ${late.de} zu spät bei ${data.paid_count} Rechnungen.`));
  } else {
    score += Math.min(data.avg_days_late * 2, 40);
    const late = days(data.avg_days_late);
    reasons.push(t(`Usually pays ${late.en} late.`, `Zahlt meist ${late.de} zu spät.`));
  }

  if (data.unpaid_count) {
    score += Math.min(data.unpaid_count * 20, 40);
    reasons.push(data.unpaid_count === 1
      ? t("1 earlier invoice was never paid.", "1 frühere Rechnung wurde nie bezahlt.")
      : t(`${data.unpaid_count} earlier invoices were never paid.`, `${data.unpaid_count} frühere Rechnungen wurden nie bezahlt.`));
  }

  if (data.days_overdue_now > 14) {
    score += 15;
    reasons.push(t(`This invoice is already ${data.days_overdue_now} days late.`, `Diese Rechnung ist schon ${data.days_overdue_now} Tage überfällig.`));
  }

  if (data.open_cents > 200000) {
    score += 5;
    reasons.push(t("The open amount is large.", "Der offene Betrag ist hoch."));
  }

  score = Math.max(0, Math.min(score, 100));
  const level = score >= 60 ? "high" : score >= 35 ? "medium" : "low";
  return { score, level, expected_days_late: data.avg_days_late + Math.min(data.unpaid_count * 15, 30), reasons };
}
