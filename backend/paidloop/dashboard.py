"""The owner's view of the money, including a real problem for small firms: not all cash is theirs.

With standard (Soll) VAT, tax is due when the invoice is issued, even if the customer has not paid.
So "spendable" here means cash minus the VAT the business has to pass on. Not tax advice.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from paidloop import followup, invoices, ledger
from paidloop.models import DISPUTED, ISSUED, ON_PLAN, PAID, Invoice, Proposal


def expected_payments(session: Session, invoice: Invoice, on: date) -> list[dict]:
    """When is this money likely to arrive? Past behaviour moves the date."""
    assessed = followup.risk_of(session, invoice, on)
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


def build(session: Session) -> dict:
    on = invoices.today(session)
    business = invoices.business_of(session)
    rows = list(session.scalars(select(Invoice).where(Invoice.number.is_not(None))))
    open_rows = [i for i in rows if i.status in {ISSUED, ON_PLAN, DISPUTED}]

    overdue = [i for i in open_rows if invoices.days_overdue(i, on) > 0]
    cash = ledger.balance(session, ledger.CASH)
    vat_due = ledger.balance(session, ledger.VAT_PAYABLE)
    vat_on_unpaid = 0
    for invoice in open_rows:
        if invoice.gross_cents:
            vat_on_unpaid += invoice.vat_cents * invoice.open_cents // invoice.gross_cents

    buckets = {"week": 0, "month": 0, "later": 0, "at_risk": 0}
    upcoming = []
    for invoice in open_rows:
        if invoice.status == DISPUTED:
            buckets["at_risk"] += invoice.open_cents
            continue
        for item in expected_payments(session, invoice, on):
            if item["risk"] == "high":
                buckets["at_risk"] += item["amount_cents"]
            elif item["expected_on"] <= on + timedelta(days=7):
                buckets["week"] += item["amount_cents"]
            elif item["expected_on"] <= on + timedelta(days=30):
                buckets["month"] += item["amount_cents"]
            else:
                buckets["later"] += item["amount_cents"]
            upcoming.append({"number": invoice.number, "customer": invoice.customer.name, **item})

    pending = session.scalar(
        select(Proposal.id).where(Proposal.status == "pending").limit(1)
    )
    debit, credit = ledger.totals(session)
    return {
        "today": on,
        "open_cents": sum(i.open_cents for i in open_rows),
        "open_count": len(open_rows),
        "overdue_cents": sum(i.open_cents for i in overdue),
        "overdue_count": len(overdue),
        "on_plan_cents": sum(i.open_cents for i in open_rows if i.status == ON_PLAN),
        "disputed_cents": sum(i.open_cents for i in open_rows if i.status == DISPUTED),
        "paid_count": sum(1 for i in rows if i.status == PAID),
        "cash_cents": cash,
        "vat_due_cents": vat_due,
        "vat_on_unpaid_cents": vat_on_unpaid if business.vat_method == "soll" else 0,
        "spendable_cents": cash - vat_due,
        "vat_method": business.vat_method,
        "forecast": buckets,
        "upcoming": sorted(upcoming, key=lambda item: item["expected_on"])[:8],
        "has_pending_approvals": bool(pending),
        "ledger_balanced": debit == credit,
    }
