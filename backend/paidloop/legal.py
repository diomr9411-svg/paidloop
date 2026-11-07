"""German late-payment rules (Sec. 286 and 288 BGB) as plain functions. Not legal advice.

- Sec. 286(1): the debtor is in default after a reminder sent after the due date.
- Sec. 286(3): the debtor is in default at the latest 30 days after the due date and receipt of the
  invoice. For consumers this only applies if the invoice says so.
- Sec. 288(1) and (2): default interest is 5 points over the base rate, or 9 points if no consumer
  is involved.
- Sec. 288(5): in B2B cases the creditor can also claim a flat 40 EUR.

A due date that the seller only prints on the invoice is not treated as a contractually agreed
calendar date (Sec. 286(2) no. 1), so this code does not assume default from the due date alone.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

# Published by the Deutsche Bundesbank, valid from 1 July 2026. It changes every 1 January and 1 July.
BASE_RATE_PERCENT = Decimal("1.52")
BASE_RATE_VALID_UNTIL = date(2026, 12, 31)

CONSUMER_POINTS = Decimal("5")
BUSINESS_POINTS = Decimal("9")
B2B_FLAT_FEE_CENTS = 4000


@dataclass(frozen=True)
class LateCosts:
    in_default: bool
    default_since: date | None
    rate_percent: Decimal
    days: int
    interest_cents: int
    flat_fee_cents: int

    @property
    def total_cents(self) -> int:
        return self.interest_cents + self.flat_fee_cents


def default_start(
    due_date: date,
    is_consumer: bool,
    consumer_notice_on_invoice: bool,
    first_reminder_after_due: date | None,
) -> date | None:
    """The first day the debtor is in default, or None if no rule applies."""
    candidates: list[date] = []
    if first_reminder_after_due and first_reminder_after_due > due_date:
        candidates.append(first_reminder_after_due)
    if not is_consumer or consumer_notice_on_invoice:
        candidates.append(due_date + timedelta(days=30))
    return min(candidates) if candidates else None


def interest_rate(is_consumer: bool, base_rate: Decimal = BASE_RATE_PERCENT) -> Decimal:
    return base_rate + (CONSUMER_POINTS if is_consumer else BUSINESS_POINTS)


def late_costs(
    open_cents: int,
    today: date,
    due_date: date,
    is_consumer: bool,
    consumer_notice_on_invoice: bool,
    first_reminder_after_due: date | None,
    base_rate: Decimal = BASE_RATE_PERCENT,
) -> LateCosts:
    since = default_start(due_date, is_consumer, consumer_notice_on_invoice, first_reminder_after_due)
    rate = interest_rate(is_consumer, base_rate)
    if since is None or today <= since or open_cents <= 0:
        return LateCosts(False, since, rate, 0, 0, 0)
    days = (today - since).days
    interest = int((Decimal(open_cents) * rate / 100 * days / 365).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return LateCosts(True, since, rate, days, interest, 0 if is_consumer else B2B_FLAT_FEE_CENTS)
