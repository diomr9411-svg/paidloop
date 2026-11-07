"""Double-entry ledger. Every event has a unique key, so replaying an event changes nothing."""

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from paidloop.models import JournalEntry, JournalLine

RECEIVABLE = "receivable"
REVENUE = "revenue"
VAT_PAYABLE = "vat_payable"
VAT_DEFERRED = "vat_deferred"  # cash-basis VAT that is not due until the customer pays
CASH = "cash_paypal"

ASSET_ACCOUNTS = {RECEIVABLE, CASH}


class UnbalancedEntry(Exception):
    pass


def post(
    session: Session,
    key: str,
    description: str,
    booked_on: date,
    lines: list[tuple[str, int, int]],
    invoice_id: int | None = None,
) -> bool:
    """Book (account, debit, credit) lines. Returns False if this key was already booked."""
    lines = [line for line in lines if line[1] or line[2]]
    if sum(line[1] for line in lines) != sum(line[2] for line in lines):
        raise UnbalancedEntry(f"Debits and credits differ for {key}")
    if any(line[1] < 0 or line[2] < 0 for line in lines):
        raise UnbalancedEntry(f"Negative amount in {key}")

    if session.scalar(select(JournalEntry.id).where(JournalEntry.idempotency_key == key)):
        return False

    entry = JournalEntry(idempotency_key=key, description=description, booked_on=booked_on, invoice_id=invoice_id)
    entry.lines = [JournalLine(account=a, debit_cents=d, credit_cents=c) for a, d, c in lines]
    session.add(entry)
    session.flush()
    return True


def balance(session: Session, account: str) -> int:
    """Asset accounts count debit minus credit. All others count credit minus debit."""
    debit, credit = session.execute(
        select(
            func.coalesce(func.sum(JournalLine.debit_cents), 0),
            func.coalesce(func.sum(JournalLine.credit_cents), 0),
        ).where(JournalLine.account == account)
    ).one()
    return int(debit - credit) if account in ASSET_ACCOUNTS else int(credit - debit)


def totals(session: Session) -> tuple[int, int]:
    debit, credit = session.execute(
        select(
            func.coalesce(func.sum(JournalLine.debit_cents), 0),
            func.coalesce(func.sum(JournalLine.credit_cents), 0),
        )
    ).one()
    return int(debit), int(credit)
