"""A simple, explainable late-payment score from clear rules. This is not machine learning."""

from __future__ import annotations

from dataclasses import dataclass, field

from paidloop.i18n import Text


@dataclass(frozen=True)
class RiskInput:
    paid_count: int
    avg_days_late: int
    unpaid_count: int
    days_overdue_now: int
    open_cents: int


@dataclass(frozen=True)
class Risk:
    score: int
    level: str
    expected_days_late: int
    reasons: tuple[Text, ...] = field(default=())


def _days(count: int) -> Text:
    return Text("1 day" if count == 1 else f"{count} days", "1 Tag" if count == 1 else f"{count} Tage")


def assess(data: RiskInput) -> Risk:
    score = 25
    reasons: list[Text] = []

    if data.paid_count == 0 and data.unpaid_count == 0:
        score += 15  # an unknown customer is not the same as a reliable one
        reasons.append(Text("No payment history yet.", "Noch keine Zahlungshistorie."))
    elif data.avg_days_late <= 3 and data.unpaid_count == 0:
        score -= 15
        days = _days(data.avg_days_late)
        reasons.append(Text(f"Pays on time: {days} late on average over {data.paid_count} invoices.",
                            f"Zahlt zuverlässig: im Schnitt {days.de} zu spät bei {data.paid_count} Rechnungen."))
    else:
        score += min(data.avg_days_late * 2, 40)
        days = _days(data.avg_days_late)
        reasons.append(Text(f"Usually pays {days} late.", f"Zahlt meist {days.de} zu spät."))

    if data.unpaid_count:
        score += min(data.unpaid_count * 20, 40)
        if data.unpaid_count == 1:
            reasons.append(Text("1 earlier invoice was never paid.", "1 frühere Rechnung wurde nie bezahlt."))
        else:
            reasons.append(Text(f"{data.unpaid_count} earlier invoices were never paid.",
                                f"{data.unpaid_count} frühere Rechnungen wurden nie bezahlt."))

    if data.days_overdue_now > 14:
        score += 15
        reasons.append(Text(f"This invoice is already {data.days_overdue_now} days late.",
                            f"Diese Rechnung ist schon {data.days_overdue_now} Tage überfällig."))

    if data.open_cents > 200000:
        score += 5
        reasons.append(Text("The open amount is large.", "Der offene Betrag ist hoch."))

    score = max(0, min(score, 100))
    level = "high" if score >= 60 else "medium" if score >= 35 else "low"
    return Risk(score, level, data.avg_days_late + min(data.unpaid_count * 15, 30), tuple(reasons))
