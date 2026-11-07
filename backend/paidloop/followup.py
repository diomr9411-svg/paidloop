"""The follow-up agent. Each day it looks at open invoices and picks the next step.

The AI proposes. The policy gate checks. Code acts. Serious steps wait for the owner.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from paidloop import audit, invoices, legal, messages, policy, risk
from paidloop.ai import AI
from paidloop.compliance import CONSUMER_NOTICE_DE
from paidloop.models import DISPUTED, ISSUED, ON_PLAN, Business, Invoice, Proposal
from paidloop.paypal import PayPalError

LEVEL_AFTER = {policy.FRIENDLY: 1, policy.FIRM: 2, policy.FINAL: 3, policy.OWNER_REVIEW: 4}


class AgentChoice(BaseModel):
    action: Literal["wait", "pre_due_note", "friendly_reminder", "firm_reminder", "final_notice", "owner_review"]
    reason: str = Field(default="", max_length=300)
    friendly_sentence: str = Field(default="", max_length=240)


SYSTEM_PROMPT = """You help a small German business decide the next step for an unpaid invoice.
You get facts as JSON and a list allowed_actions. Choose exactly one action from allowed_actions.
Most small delays resolve within a week, so waiting is good for reliable customers who are only a little late.
Do not choose a harsher step just because it is allowed if waiting a little is kinder and low risk, but do not
wait when the risk is high. reason is one short plain English sentence for the owner that uses the facts.
friendly_sentence is one warm opening sentence in the customer's language, with no numbers, dates, promises,
discounts, threats or legal words. Leave it empty if unsure."""


def limits_of(business: Business) -> policy.Limits:
    return policy.Limits(
        max_installments=business.max_installments,
        min_first_payment_pct=business.min_first_payment_pct,
        max_plan_days=business.max_plan_days,
        min_installment_cents=business.min_installment_cents,
        reminder_gap_days=business.reminder_gap_days,
    )


def risk_of(session: Session, invoice: Invoice, on: date) -> risk.Risk:
    customer = invoice.customer
    paid_here = [i for i in customer.invoices if i.paid_on and i.due_date and i.id != invoice.id]
    late_here = [max((i.paid_on - i.due_date).days, 0) for i in paid_here]
    paid_count = customer.history_paid_count + len(paid_here)
    total_late = customer.history_avg_days_late * customer.history_paid_count + sum(late_here)
    return risk.assess(
        risk.RiskInput(
            paid_count=paid_count,
            avg_days_late=total_late // paid_count if paid_count else 0,
            unpaid_count=customer.history_unpaid_count,
            days_overdue_now=max(invoices.days_overdue(invoice, on), 0),
            open_cents=invoice.open_cents,
        )
    )


def facts_of(session: Session, invoice: Invoice, on: date, level: str) -> policy.FollowupFacts:
    return policy.FollowupFacts(
        days_overdue=invoices.days_overdue(invoice, on),
        reminder_level=invoice.reminder_level,
        days_since_reminder=(on - invoice.last_reminder_on).days if invoice.last_reminder_on else None,
        paused=bool(invoice.paused_until and invoice.paused_until > on),
        disputed=invoice.status == DISPUTED,
        open_cents=invoice.open_cents,
        risk_level=level,
    )


def late_costs_of(invoice: Invoice, on: date) -> legal.LateCosts:
    consumer = not invoice.customer.is_business
    return legal.late_costs(
        invoice.open_cents,
        on,
        invoice.due_date,
        consumer,
        consumer_notice_on_invoice=consumer,  # the check adds this notice to every consumer invoice
        first_reminder_after_due=invoice.default_since,
    )


def target_paypal_id(invoice: Invoice) -> str | None:
    plan = invoice.active_plan
    if plan:
        unpaid = [i for i in plan.installments if not i.is_paid and i.paypal_id]
        if unpaid:
            return unpaid[0].paypal_id
    return invoice.paypal_id


def open_amount_for_message(invoice: Invoice) -> tuple[int, date]:
    plan = invoice.active_plan
    if plan:
        unpaid = [i for i in plan.installments if not i.is_paid]
        if unpaid:
            return unpaid[0].amount_cents - unpaid[0].paid_cents, unpaid[0].due_date
    return invoice.open_cents, invoice.due_date


def _message(invoice: Invoice, business: Business, action: str, on: date, public_base: str, ai_sentence: str = ""):
    amount, due = open_amount_for_message(invoice)
    return messages.reminder(
        action,
        invoice.customer.language,
        invoice.customer.name,
        invoice.number,
        amount,
        due,
        f"{public_base}/#/pay/{invoice.public_token}",
        business.name,
        late_costs_of(invoice, on) if action == policy.FINAL else None,
        messages.safe_ai_sentence(ai_sentence),
    )


@dataclass
class Outcome:
    invoice_id: int
    number: str
    action: str
    reason: str
    decided_by: str  # ai or rules
    status: str  # done, waiting_for_owner, nothing, failed


def _choose(invoice: Invoice, facts: policy.FollowupFacts, limits: policy.Limits, assessed: risk.Risk, ai: AI,
            session: Session) -> tuple[str, str, str, str]:
    options = policy.allowed_actions(facts, limits)
    rule_action, rule_reason = policy.rule_choice(facts, limits)
    if len(options) == 1:
        return rule_action, rule_reason, "rules", ""
    data = {
        "days_overdue": facts.days_overdue,
        "open_amount_eur": round(facts.open_cents / 100, 2),
        "customer_type": "business" if invoice.customer.is_business else "private person",
        "customer_language": invoice.customer.language,
        "reminders_so_far": facts.reminder_level,
        "risk_level": assessed.level,
        "risk_reasons": list(assessed.reasons),
        "allowed_actions": options,
    }
    answer = ai.ask_json(SYSTEM_PROMPT, json.dumps(data, ensure_ascii=False), AgentChoice)
    if answer is None:
        return rule_action, rule_reason, "rules", ""
    verdict = policy.gate(answer.action, facts, limits)
    if not verdict.allowed:
        audit.record(session, "rules", "ai_choice_refused", invoice.id, proposed=answer.action, why=verdict.reason)
        return rule_action, f"The AI's choice was refused, so the rules decided. {rule_reason}", "rules", ""
    reason = " ".join(answer.reason.split())[:300] or rule_reason
    return answer.action, reason, "ai", answer.friendly_sentence


def run(session: Session, paypal, ai: AI, public_base: str) -> list[Outcome]:
    business = invoices.business_of(session)
    limits = limits_of(business)
    on = invoices.today(session)
    outcomes: list[Outcome] = []
    rows = session.scalars(select(Invoice).where(Invoice.status.in_([ISSUED, ON_PLAN, DISPUTED])).order_by(Invoice.id))
    for invoice in list(rows):
        try:
            invoices.sync(session, invoice, paypal)
        except PayPalError:
            pass  # a stale view is safe here: a later run picks up the payment, and reminders are spaced out
        if invoice.status not in {ISSUED, ON_PLAN, DISPUTED}:
            outcomes.append(Outcome(invoice.id, invoice.number, policy.WAIT, "The invoice has just been paid.", "rules", "nothing"))
            continue
        if any(p.status == "pending" for p in invoice.proposals):
            outcomes.append(Outcome(invoice.id, invoice.number, policy.WAIT, "A step is already waiting for your approval.", "rules", "nothing"))
            continue

        assessed = risk_of(session, invoice, on)
        facts = facts_of(session, invoice, on, assessed.level)
        action, reason, decided_by, sentence = _choose(invoice, facts, limits, assessed, ai, session)
        verdict = policy.gate(action, facts, limits)
        if action == policy.WAIT or not verdict.allowed:
            outcomes.append(Outcome(invoice.id, invoice.number, policy.WAIT, reason, decided_by, "nothing"))
            continue

        text = _message(invoice, business, action, on, public_base, sentence)
        if verdict.needs_owner:
            session.add(
                Proposal(invoice=invoice, action=action, reason=reason, decided_by_ai=decided_by == "ai",
                         subject=text.subject, body=text.body,
                         payload=json.dumps({"english": text.english_for_owner}, ensure_ascii=False))
            )
            audit.record(session, decided_by, "proposed", invoice.id, action=action, reason=reason)
            outcomes.append(Outcome(invoice.id, invoice.number, action, reason, decided_by, "waiting_for_owner"))
            continue

        try:
            _send(session, invoice, paypal, action, text.subject, text.body, on, decided_by, reason)
        except PayPalError as error:
            audit.record(session, "paypal", "reminder_failed", invoice.id, action=action, error=str(error)[:200])
            outcomes.append(Outcome(invoice.id, invoice.number, action, f"PayPal did not accept it: {error}", decided_by, "failed"))
            continue
        outcomes.append(Outcome(invoice.id, invoice.number, action, reason, decided_by, "done"))
    session.flush()
    return outcomes


def _send(session: Session, invoice: Invoice, paypal, action: str, subject: str, body: str, on: date, actor: str, reason: str) -> None:
    target = target_paypal_id(invoice)
    if action != policy.OWNER_REVIEW and target:
        paypal.remind(target, subject, body)
    invoice.last_reminder_on = on
    if action in LEVEL_AFTER:
        invoice.reminder_level = LEVEL_AFTER[action]
    if action == policy.FIRM and invoice.default_since is None:
        invoice.default_since = on  # a clear reminder after the due date starts default (Sec. 286(1) BGB)
    audit.record(session, actor, "reminder_sent" if action != policy.OWNER_REVIEW else "owner_review_done",
                 invoice.id, action=action, reason=reason, subject=subject)


def approve(session: Session, proposal: Proposal, paypal, edited_body: str | None = None) -> str:
    """The owner says yes. Everything is checked again, because things may have changed since the proposal."""
    from paidloop import negotiation

    if proposal.status != "pending":
        return "This step was already decided."
    invoice = proposal.invoice
    business = invoices.business_of(session)
    on = invoices.today(session)
    proposal.decided_at = datetime.now(timezone.utc)

    if proposal.action == negotiation.PLAN_EXCEPTION:
        negotiation.approve_exception(session, proposal, on)
        proposal.status = "done"
        audit.record(session, "owner", "approved", invoice.id, action=proposal.action)
        return "The plan is now offered to the customer."
    if proposal.action in {negotiation.DISPUTE_REVIEW, negotiation.PAYMENT_CHECK}:
        if invoice.status == DISPUTED:
            invoices.resume_after_dispute(session, invoice)
        invoice.paused_until = None
        proposal.status = "done"
        audit.record(session, "owner", "approved", invoice.id, action=proposal.action)
        return "Reminders continue as normal."

    try:
        invoices.sync(session, invoice, paypal)
    except PayPalError:
        pass
    if invoice.status not in {ISSUED, ON_PLAN}:
        proposal.status = "obsolete"
        return "No reminder was sent, because the invoice is no longer open or is on hold."

    assessed = risk_of(session, invoice, on)
    facts = facts_of(session, invoice, on, assessed.level)
    verdict = policy.gate(proposal.action, facts, limits_of(business))
    if not verdict.allowed:
        proposal.status = "obsolete"
        audit.record(session, "rules", "approval_refused", invoice.id, action=proposal.action, why=verdict.reason)
        return f"Not sent: {verdict.reason}"

    body = (edited_body or proposal.body).strip()
    _send(session, invoice, paypal, proposal.action, proposal.subject, body, on, "owner", proposal.reason)
    proposal.body = body
    proposal.status = "done"
    audit.record(session, "owner", "approved", invoice.id, action=proposal.action, edited=edited_body is not None)
    return "Sent."


def reject(session: Session, proposal: Proposal) -> str:
    if proposal.status != "pending":
        return "This step was already decided."
    proposal.status = "rejected"
    proposal.decided_at = datetime.now(timezone.utc)
    invoice = proposal.invoice
    # Respect the owner's no: do not propose the same step again until the normal gap has passed.
    invoice.last_reminder_on = invoices.today(session)
    audit.record(session, "owner", "rejected", invoice.id, action=proposal.action)
    return "OK, nothing was sent."


NOTICE_USED = CONSUMER_NOTICE_DE
