"""Money helpers. Amounts are whole cents (int) everywhere, so rounding errors cannot build up."""

from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def to_cents(value: Decimal | str | int | float) -> int:
    """Convert euros to cents, rounding half up as invoices normally do."""
    return int((Decimal(str(value)) / CENT).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def to_decimal(cents: int) -> Decimal:
    return (Decimal(cents) * CENT).quantize(CENT)


def percent_of(cents: int, basis_points: int) -> int:
    """Return a percentage of an amount. 19% is 1900 basis points."""
    return int((Decimal(cents) * basis_points / 10000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def line_net(quantity_milli: int, unit_price_cents: int) -> int:
    """Net line total. Quantity is in thousandths, so 1.5 hours is 1500."""
    return int((Decimal(quantity_milli) * unit_price_cents / 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def eur(cents: int) -> str:
    """Format for messages and PDFs: 1234.5 EUR becomes 1,234.50 EUR."""
    return f"{to_decimal(cents):,.2f} EUR"


def eur_de(cents: int) -> str:
    """German format: 1.234,50 EUR."""
    text = f"{to_decimal(cents):,.2f}"
    return text.replace(",", "X").replace(".", ",").replace("X", ".") + " EUR"
