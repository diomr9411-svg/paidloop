"""A simple, explainable late-payment score from clear rules. This is not machine learning."""

from __future__ import annotations

from dataclasses import dataclass, field


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
    reasons: tuple[str, ...] = field(default=())


def assess(data: RiskInput) -> Risk:
    score = 25
    reasons: list[str] = []

    if data.paid_count == 0 and data.unpaid_count == 0:
        score += 15  # an unknown customer is not the same as a reliable one
        reasons.append("No payment history yet.")
    elif data.avg_days_late <= 3 and data.unpaid_count == 0:
        score -= 15
        days = "1 day" if data.avg_days_late == 1 else f"{data.avg_days_late} days"
        reasons.append(f"Pays on time: {days} late on average over {data.paid_count} invoices.")
    else:
        points = min(data.avg_days_late * 2, 40)
        score += points
        reasons.append(f"Usually pays {data.avg_days_late} days late.")

    if data.unpaid_count:
        score += min(data.unpaid_count * 20, 40)
        reasons.append(f"{data.unpaid_count} earlier invoice(s) were never paid.")

    if data.days_overdue_now > 14:
        score += 15
        reasons.append(f"This invoice is already {data.days_overdue_now} days late.")

    if data.open_cents > 200000:
        score += 5
        reasons.append("The open amount is large.")

    score = max(0, min(score, 100))
    level = "high" if score >= 60 else "medium" if score >= 35 else "low"
    return Risk(score, level, data.avg_days_late + min(data.unpaid_count * 15, 30), tuple(reasons))
