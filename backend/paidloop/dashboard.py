"""The owner's view of the money, and a simple work queue of what to do next.

A real problem for small firms: not all cash is theirs. With standard (Soll) VAT, tax is due when the
invoice is issued, even if the customer has not paid. So "spendable" here means cash minus the VAT
the business has to pass on. Not tax advice.

Numbers come from SQL on indexed columns, so this screen stays fast with many old invoices.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, selectinload

from paidloop import followup, invoices, ledger
from paidloop.models import CHECKED, DISPUTED, DRAFT, ISSUED, ON_PLAN, PAID, Invoice, PaymentPlan, Proposal

QUEUE_SIZE = 8


def expected_payments(invoice: Invoice, assessed, on: date) -> list[dict]:
    """When is this money likely to arrive? Past behaviour moves the date."""
    plan = invoice.active_plan
    if plan:
        items = [(i.due_date, i.amount_cents - i.paid_cents) for i in plan.installments if not i.is_paid]
    else:
        items = [(invoice.due_date, invoice.open_cents)]
    results = []
    for due, amount in items:
        expected = max(due + timedelta(days=assessed.expected_days_late), on)
        results.append({"expected_on": expected, "amount_cents": amount, "risk": assessed.level})
    return results


def performance(session: Session) -> dict:
    """How well does getting paid work? Measured from real invoices, like cycle time in a factory."""
    days_to_paid = func.julianday(Invoice.paid_on) - func.julianday(Invoice.issue_date)
    count, average, on_time = session.execute(
        select(
            func.count(Invoice.id),
            func.avg(days_to_paid),
            func.sum(case((Invoice.paid_on <= Invoice.due_date, 1), else_=0)),
        ).where(Invoice.status == PAID)
    ).one()
    average_seconds, timed = session.execute(
        select(func.avg(Invoice.seconds_to_issue), func.count(Invoice.seconds_to_issue)).where(
            Invoice.seconds_to_issue.is_not(None)
        )
    ).one()
    return {
        "paid_count": count,
        "avg_days_to_paid": round(average, 1) if average is not None else None,
        "on_time_percent": round(100 * (on_time or 0) / count) if count else None,
        "avg_seconds_to_issue": round(average_seconds) if average_seconds is not None else None,
        "timed_invoices": timed,
    }


def _queue(session: Session, open_rows: list[Invoice], on: date) -> list[dict]:
    """Most valuable work first, one clear next step each: the owner pulls from this list."""
    queue: list[dict] = []
    pending = session.scalars(
        select(Proposal)
        .where(Proposal.status == "pending")
        .options(selectinload(Proposal.invoice).selectinload(Invoice.customer))
        .order_by(Proposal.id)
    )
    with_pending = set()
    for proposal in pending:
        with_pending.add(proposal.invoice_id)
        invoice = proposal.invoice
        queue.append(
            {
                "kind": "approval",
                "action": proposal.action,
                "invoice_id": invoice.id,
                "number": invoice.number,
                "customer": invoice.customer.name if invoice.customer else "",
                "amount_cents": invoice.open_cents,
                "days_late": max(invoices.days_overdue(invoice, on), 0),
            }
        )
    for invoice in open_rows:
        days = invoices.days_overdue(invoice, on)
        if invoice.id in with_pending or days <= 0 or invoice.status == DISPUTED:
            continue
        if invoice.last_reminder_on is None:
            queue.append(
                {
                    "kind": "no_reminder_yet",
                    "action": "",
                    "invoice_id": invoice.id,
                    "number": invoice.number,
                    "customer": invoice.customer.name,
                    "amount_cents": invoice.open_cents,
                    "days_late": days,
                }
            )
    drafts = session.scalars(
        select(Invoice)
        .where(Invoice.status.in_([DRAFT, CHECKED]))
        .options(selectinload(Invoice.customer))
        .order_by(Invoice.id.desc())
        .limit(QUEUE_SIZE)
    )
    for invoice in drafts:
        queue.append(
            {
                "kind": "draft",
                "action": "",
                "invoice_id": invoice.id,
                "number": None,
                "customer": invoice.customer.name if invoice.customer else "",
                "amount_cents": invoice.gross_cents,
                "days_late": 0,
            }
        )
    order = {"approval": 0, "no_reminder_yet": 1, "draft": 2}
    queue.sort(key=lambda item: (order[item["kind"]], -item["amount_cents"]))
    return queue[:QUEUE_SIZE]


def build(session: Session) -> dict:
    on = invoices.today(session)
    business = invoices.business_of(session)
    open_rows = list(
        session.scalars(
            select(Invoice)
            .where(Invoice.status.in_([ISSUED, ON_PLAN, DISPUTED]))
            .options(selectinload(Invoice.customer), selectinload(Invoice.plans).selectinload(PaymentPlan.installments))
        )
    )

    overdue = [i for i in open_rows if invoices.days_overdue(i, on) > 0]
    cash = ledger.balance(session, ledger.CASH)
    vat_due = ledger.balance(session, ledger.VAT_PAYABLE)
    vat_on_unpaid = 0
    for invoice in open_rows:
        if invoice.gross_cents:
            vat_on_unpaid += invoice.vat_cents * invoice.open_cents // invoice.gross_cents

    aging = {"not_due": 0, "days_1_30": 0, "days_31_60": 0, "days_61_plus": 0}
    for invoice in open_rows:
        days = invoices.days_overdue(invoice, on)
        bucket = "not_due" if days <= 0 else "days_1_30" if days <= 30 else "days_31_60" if days <= 60 else "days_61_plus"
        aging[bucket] += invoice.open_cents

    stats = followup.customer_stats(session)
    buckets = {"week": 0, "month": 0, "later": 0, "at_risk": 0}
    upcoming = []
    for invoice in open_rows:
        if invoice.status == DISPUTED:
            buckets["at_risk"] += invoice.open_cents
            continue
        assessed = followup.risk_of(session, invoice, on, stats)
        for item in expected_payments(invoice, assessed, on):
            if item["risk"] == "high":
                buckets["at_risk"] += item["amount_cents"]
            elif item["expected_on"] <= on + timedelta(days=7):
                buckets["week"] += item["amount_cents"]
            elif item["expected_on"] <= on + timedelta(days=30):
                buckets["month"] += item["amount_cents"]
            else:
                buckets["later"] += item["amount_cents"]
            upcoming.append({"number": invoice.number, "invoice_id": invoice.id, "customer": invoice.customer.name, **item})

    debit, credit = ledger.totals(session)
    results = performance(session)
    return {
        "today": on,
        "open_cents": sum(i.open_cents for i in open_rows),
        "open_count": len(open_rows),
        "overdue_cents": sum(i.open_cents for i in overdue),
        "overdue_count": len(overdue),
        "on_plan_cents": sum(i.open_cents for i in open_rows if i.status == ON_PLAN),
        "on_plan_count": sum(1 for i in open_rows if i.status == ON_PLAN),
        "disputed_cents": sum(i.open_cents for i in open_rows if i.status == DISPUTED),
        "disputed_count": sum(1 for i in open_rows if i.status == DISPUTED),
        "paid_count": results["paid_count"],
        "cash_cents": cash,
        "vat_due_cents": vat_due,
        "vat_on_unpaid_cents": vat_on_unpaid if business.vat_method == "soll" else 0,
        "spendable_cents": cash - vat_due,
        "vat_method": business.vat_method,
        "forecast": buckets,
        "aging": aging,
        "performance": results,
        "queue": _queue(session, open_rows, on),
        "upcoming": sorted(upcoming, key=lambda item: item["expected_on"])[:8],
        "ledger_balanced": debit == credit,
    }
