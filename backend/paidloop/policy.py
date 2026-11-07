"""The safety core. The AI only proposes; this code decides what is allowed.

Limits live here in code and in the owner's settings, never in an AI prompt, so no message from a
customer can change them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from paidloop.i18n import Text

WAIT = "wait"
PRE_DUE = "pre_due_note"
FRIENDLY = "friendly_reminder"
FIRM = "firm_reminder"
FINAL = "final_notice"
OWNER_REVIEW = "owner_review"

SERIOUS_ACTIONS = {FIRM, FINAL, OWNER_REVIEW}

FIRM_AFTER_DAYS = 14
FINAL_AFTER_DAYS = 30
OWNER_AFTER_DAYS = 45
PRE_DUE_DAYS = 3
PLAN_SPACING_DAYS = 30
FIRST_PAYMENT_DAYS = 3


@dataclass(frozen=True)
class Limits:
    max_installments: int = 4
    min_first_payment_pct: int = 20
    max_plan_days: int = 90
    min_installment_cents: int = 2000
    reminder_gap_days: int = 7


@dataclass(frozen=True)
class FollowupFacts:
    days_overdue: int  # negative before the due date
    reminder_level: int  # 0 none, 1 friendly, 2 firm, 3 final, 4 owner
    days_since_reminder: int | None
    paused: bool
    disputed: bool
    open_cents: int
    risk_level: str  # low, medium or high


def allowed_actions(facts: FollowupFacts, limits: Limits) -> list[str]:
    """Waiting is always allowed. A stronger step is allowed only when its time has come."""
    actions = [WAIT]
    if facts.paused or facts.disputed or facts.open_cents <= 0:
        return actions
    if facts.days_since_reminder is not None and facts.days_since_reminder < limits.reminder_gap_days:
        return actions
    if facts.days_overdue < 0:
        if -PRE_DUE_DAYS <= facts.days_overdue and facts.reminder_level == 0 and facts.days_since_reminder is None:
            actions.append(PRE_DUE)
        return actions
    if facts.days_overdue >= 1 and facts.reminder_level == 0:
        actions.append(FRIENDLY)
    elif facts.days_overdue >= FIRM_AFTER_DAYS and facts.reminder_level == 1:
        actions.append(FIRM)
    elif facts.days_overdue >= FINAL_AFTER_DAYS and facts.reminder_level == 2:
        actions.append(FINAL)
    elif facts.days_overdue >= OWNER_AFTER_DAYS and facts.reminder_level == 3:
        actions.append(OWNER_REVIEW)
    return actions


@dataclass(frozen=True)
class GateResult:
    allowed: bool
    needs_owner: bool
    reason: Text


def gate(action: str, facts: FollowupFacts, limits: Limits) -> GateResult:
    """Every action passes here before it runs, whether it came from the AI or from rules."""
    if action not in allowed_actions(facts, limits):
        return GateResult(False, False, Text(f"'{action}' is not allowed for this invoice right now.",
                                             f"'{action}' ist für diese Rechnung gerade nicht erlaubt."))
    return GateResult(True, action in SERIOUS_ACTIONS, Text("Allowed by the owner's limits.", "Im Rahmen Ihrer Grenzen erlaubt."))


def reason_for(action: str, facts: FollowupFacts) -> Text:
    """A plain explanation of a step in both languages, whoever chose it."""
    days = facts.days_overdue
    if action == PRE_DUE:
        return Text("This customer often pays late, so a short note before the due date can help.",
                    "Dieser Kunde zahlt oft spät, deshalb hilft eine kurze Nachricht vor der Fälligkeit.")
    if action == FRIENDLY:
        return Text(f"The invoice is {days} days late and no reminder was sent yet.",
                    f"Die Rechnung ist {days} Tage überfällig, und es wurde noch nicht erinnert.")
    if action == FIRM:
        return Text(f"The invoice is {days} days late, and the friendly reminder did not work.",
                    f"Die Rechnung ist {days} Tage überfällig, die freundliche Erinnerung hat nicht gewirkt.")
    if action == FINAL:
        return Text(f"The invoice is {days} days late, even after a firm reminder.",
                    f"Die Rechnung ist {days} Tage überfällig, trotz Mahnung.")
    if action == OWNER_REVIEW:
        return Text(f"The invoice is {days} days late, even after a final notice. You should decide the next step.",
                    f"Die Rechnung ist {days} Tage überfällig, trotz letzter Mahnung. Bitte entscheiden Sie den nächsten Schritt.")
    return Text("No step is due yet.", "Noch kein Schritt fällig.")


def rule_choice(facts: FollowupFacts, limits: Limits) -> tuple[str, Text]:
    """What the rules do when no AI is available, and the safe default when the AI's answer is refused."""
    options = allowed_actions(facts, limits)
    if len(options) == 1:
        if facts.paused:
            return WAIT, Text("Reminders are paused for this invoice.", "Die Erinnerungen für diese Rechnung sind pausiert.")
        if facts.disputed:
            return WAIT, Text("The customer has raised a problem. The owner must look first.",
                              "Der Kunde hat ein Problem gemeldet. Sie müssen zuerst prüfen.")
        return WAIT, reason_for(WAIT, facts)
    action = options[-1]
    if action == PRE_DUE and facts.risk_level != "high":
        return WAIT, Text("This customer usually pays on time, so no note is needed before the due date.",
                          "Dieser Kunde zahlt meist pünktlich, daher ist vor der Fälligkeit keine Nachricht nötig.")
    if action == FRIENDLY and facts.risk_level == "low" and facts.days_overdue < 4:
        return WAIT, Text("This customer pays reliably and is only a few days late. Most such payments arrive within a week.",
                          "Dieser Kunde zahlt zuverlässig und ist nur wenige Tage spät. Solche Zahlungen kommen meist innerhalb einer Woche.")
    return action, reason_for(action, facts)


# Payment plans


@dataclass(frozen=True)
class PlannedPayment:
    amount_cents: int
    due_date: date


@dataclass(frozen=True)
class PlanOffer:
    payments: tuple[PlannedPayment, ...]
    was_adjusted: bool


def most_installments(open_cents: int, limits: Limits) -> int:
    by_days = limits.max_plan_days // PLAN_SPACING_DAYS + 1
    by_amount = open_cents // limits.min_installment_cents if limits.min_installment_cents else limits.max_installments
    return max(min(limits.max_installments, by_days, by_amount), 0)


def smallest_first_payment(open_cents: int, limits: Limits) -> int:
    from_percent = (open_cents * limits.min_first_payment_pct + 99) // 100
    return max(from_percent, min(limits.min_installment_cents, open_cents))


def build_offer(
    open_cents: int,
    requested_count: int | None,
    requested_first_cents: int | None,
    today: date,
    limits: Limits,
) -> PlanOffer | None:
    """The closest plan inside the limits, or None if no plan fits at all."""
    top = most_installments(open_cents, limits)
    if top < 2:
        return None
    wanted = requested_count if requested_count else min(3, top)
    count = min(max(wanted, 2), top)
    adjusted = count != wanted

    lowest = smallest_first_payment(open_cents, limits)
    first = requested_first_cents if requested_first_cents else 0
    if first and first < lowest:
        adjusted = True
    even_first = open_cents // count + open_cents % count
    if not first:
        first = max(lowest, even_first)
    first = max(first, lowest)
    highest = open_cents - (count - 1) * limits.min_installment_cents
    if first > highest:
        first = highest
        adjusted = True

    rest = open_cents - first
    each = rest // (count - 1)
    extra = rest - each * (count - 1)
    payments = [PlannedPayment(first, today + timedelta(days=FIRST_PAYMENT_DAYS))]
    for index in range(1, count):
        amount = each + (extra if index == count - 1 else 0)
        payments.append(PlannedPayment(amount, today + timedelta(days=FIRST_PAYMENT_DAYS + PLAN_SPACING_DAYS * index)))
    return PlanOffer(tuple(payments), adjusted)


def plan_problems(open_cents: int, payments: tuple[PlannedPayment, ...], today: date, limits: Limits) -> list[str]:
    """Checks a finished plan. Nothing reaches a customer or PayPal without passing this."""
    problems: list[str] = []
    if len(payments) < 2:
        problems.append("A plan needs at least two payments.")
    if len(payments) > limits.max_installments:
        problems.append("More payments than the owner allows.")
    if sum(p.amount_cents for p in payments) != open_cents:
        problems.append("The payments do not add up to the open amount.")
    if any(p.amount_cents < limits.min_installment_cents for p in payments):
        problems.append("A payment is below the owner's minimum.")
    if payments and payments[0].amount_cents * 100 < open_cents * limits.min_first_payment_pct:
        problems.append("The first payment is below the owner's minimum.")
    if payments and (max(p.due_date for p in payments) - today).days > limits.max_plan_days + FIRST_PAYMENT_DAYS:
        problems.append("The plan runs longer than the owner allows.")
    dates = [p.due_date for p in payments]
    if dates != sorted(dates) or len(set(dates)) != len(dates):
        problems.append("The payment dates are not in order.")
    if payments and payments[0].due_date < today:
        problems.append("A payment date is in the past.")
    return problems
