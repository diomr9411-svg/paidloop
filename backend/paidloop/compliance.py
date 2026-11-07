"""Checks an invoice against German rules. Fixed code with tests, never AI. Not tax or legal advice.

Sources: Sec. 14(4) UStG (required fields), Sec. 19 UStG (small business), Sec. 33 UStDV (small
invoices up to 250 EUR gross), Sec. 14b(1) UStG (keeping invoices for work on property), Sec. 286(3)
BGB (consumer notice).
"""

from dataclasses import dataclass, field
from datetime import date

from paidloop.money import line_net, percent_of

ERROR = "error"  # blocks issuing
WARNING = "warning"  # issuing is allowed, the owner should look
INFO = "info"

SMALL_INVOICE_LIMIT_CENTS = 25000
ALLOWED_VAT_BP = {1900, 700}

CONSUMER_NOTICE_DE = (
    "Hinweis: Sie kommen spätestens 30 Tage nach Fälligkeit und Zugang dieser Rechnung in Verzug, "
    "wenn Sie nicht zahlen (§ 286 Abs. 3 BGB)."
)
SMALL_BUSINESS_NOTE_DE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
RETENTION_NOTE_DE = "Bitte bewahren Sie diese Rechnung zwei Jahre auf (§ 14b Abs. 1 Satz 5 UStG)."


@dataclass(frozen=True)
class Party:
    name: str = ""
    street: str = ""
    postcode: str = ""
    city: str = ""
    country: str = "DE"
    email: str = ""

    @property
    def has_full_address(self) -> bool:
        return bool(self.name.strip() and self.street.strip() and self.postcode.strip() and self.city.strip())


@dataclass(frozen=True)
class Line:
    description: str
    quantity_milli: int
    unit_price_cents: int
    vat_bp: int
    net_cents: int


@dataclass(frozen=True)
class InvoiceFacts:
    seller: Party
    buyer: Party
    seller_vat_id: str
    seller_tax_number: str
    seller_small_business: bool
    buyer_is_business: bool
    issue_date: date | None
    service_date: date | None
    due_date: date | None
    property_work: bool
    lines: tuple[Line, ...]
    vat_cents: int
    gross_cents: int


@dataclass(frozen=True)
class Issue:
    rule_id: str
    severity: str
    field: str
    law: str
    message: str
    fix: str


@dataclass
class CheckResult:
    issues: list[Issue] = field(default_factory=list)
    notes_to_print: list[str] = field(default_factory=list)

    @property
    def can_issue(self) -> bool:
        return not any(issue.severity == ERROR for issue in self.issues)


def vat_groups(lines: tuple[Line, ...] | list[Line]) -> dict[int, tuple[int, int]]:
    """Per VAT rate: (net total, VAT). VAT is worked out per rate, as EN 16931 requires."""
    nets: dict[int, int] = {}
    for line in lines:
        nets[line.vat_bp] = nets.get(line.vat_bp, 0) + line.net_cents
    return {bp: (net, percent_of(net, bp)) for bp, net in nets.items()}


def check(facts: InvoiceFacts) -> CheckResult:
    result = CheckResult()
    add = result.issues.append
    net_total = sum(line.net_cents for line in facts.lines)
    small_invoice = 0 < facts.gross_cents <= SMALL_INVOICE_LIMIT_CENTS

    if not facts.seller.has_full_address:
        add(Issue("R-14-1-SELLER", ERROR, "seller", "Sec. 14(4) no. 1 UStG",
                  "Your full name and address are missing.", "Add them in your business settings."))

    if not facts.buyer.name.strip():
        add(Issue("R-14-1-BUYER", ERROR, "buyer.name", "Sec. 14(4) no. 1 UStG",
                  "The customer's name is missing.", "Add the customer's full name."))
    elif not facts.buyer.has_full_address:
        if small_invoice:
            add(Issue("R-33-BUYER", INFO, "buyer.address", "Sec. 33 UStDV",
                      "Invoices up to 250 EUR gross can leave out the customer's address.",
                      "You can still add it, as this helps with reminders."))
        else:
            add(Issue("R-14-1-BUYER-ADDRESS", ERROR, "buyer.address", "Sec. 14(4) no. 1 UStG",
                      "The customer's full address is missing.", "Add street, postcode and city."))

    if not (facts.seller_vat_id.strip() or facts.seller_tax_number.strip()) and not small_invoice:
        add(Issue("R-14-2-TAX-ID", ERROR, "seller.tax", "Sec. 14(4) no. 2 UStG",
                  "Your tax number or VAT ID is missing.", "Add one in your business settings."))

    if facts.issue_date is None:
        add(Issue("R-14-3-DATE", ERROR, "issue_date", "Sec. 14(4) no. 3 UStG",
                  "The issue date is missing.", "Set the invoice date."))

    if not facts.lines:
        add(Issue("R-14-5-LINES", ERROR, "lines", "Sec. 14(4) no. 5 UStG",
                  "The invoice has no items.", "Add at least one item."))

    for position, line in enumerate(facts.lines, start=1):
        if not line.description.strip():
            add(Issue("R-14-5-DESC", ERROR, f"lines.{position}.description", "Sec. 14(4) no. 5 UStG",
                      f"Item {position} does not say what was delivered or done.", "Describe the work or goods."))
        if line.quantity_milli <= 0:
            add(Issue("R-14-5-QTY", ERROR, f"lines.{position}.quantity", "Sec. 14(4) no. 5 UStG",
                      f"Item {position} has no quantity.", "Enter a quantity above zero."))
        if line.unit_price_cents <= 0:
            add(Issue("R-PRICE", ERROR, f"lines.{position}.price", "Sec. 14(4) no. 7 UStG",
                      f"Item {position} has no price.", "Enter a price above zero."))
        if line.net_cents != line_net(line.quantity_milli, line.unit_price_cents):
            add(Issue("R-MATH-LINE", ERROR, f"lines.{position}.net", "Sec. 14(4) no. 7 UStG",
                      f"Item {position}: quantity times price does not match its total.", "Recalculate this item."))

    if facts.service_date is None and not small_invoice:
        add(Issue("R-14-6-SERVICE-DATE", ERROR, "service_date", "Sec. 14(4) no. 6 UStG",
                  "The date of the work or delivery is missing.", "Enter when the work was done."))

    if facts.seller_small_business:
        if facts.vat_cents != 0 or any(line.vat_bp != 0 for line in facts.lines):
            add(Issue("R-19-NO-VAT", ERROR, "vat", "Sec. 19 UStG, Sec. 14c UStG",
                      "As a small business you must not show VAT. VAT shown by mistake can still be owed.",
                      "Set VAT to 0% on all items."))
        result.notes_to_print.append(SMALL_BUSINESS_NOTE_DE)
    else:
        for position, line in enumerate(facts.lines, start=1):
            if line.vat_bp not in ALLOWED_VAT_BP:
                add(Issue("R-14-8-RATE", ERROR, f"lines.{position}.vat", "Sec. 14(4) no. 8 UStG",
                          f"Item {position}: only 19% and 7% are supported here.",
                          "Choose 19% or 7%. Ask a tax adviser about exempt sales."))
        groups = vat_groups(facts.lines)
        if facts.vat_cents != sum(vat for _, vat in groups.values()):
            add(Issue("R-MATH-VAT", ERROR, "vat", "Sec. 14(4) no. 8 UStG",
                      "The VAT total does not match the items.", "Recalculate the invoice."))

    if facts.gross_cents != net_total + facts.vat_cents:
        add(Issue("R-MATH-TOTAL", ERROR, "gross", "Sec. 14(4) no. 7 and 8 UStG",
                  "Net plus VAT does not equal the total.", "Recalculate the invoice."))

    if facts.due_date is None:
        add(Issue("R-DUE", ERROR, "due_date", "Sec. 286 BGB",
                  "There is no payment date, so reminders cannot be timed.", "Set a due date."))
    elif facts.issue_date and facts.due_date < facts.issue_date:
        add(Issue("R-DUE-ORDER", ERROR, "due_date", "Sec. 286 BGB",
                  "The due date is before the invoice date.", "Correct the due date."))

    if not facts.buyer.email.strip():
        add(Issue("R-EMAIL", ERROR, "buyer.email", "PayPal invoicing",
                  "The customer's email is missing, so PayPal cannot link the payment request.",
                  "Add the customer's email."))

    if not facts.buyer_is_business:
        result.notes_to_print.append(CONSUMER_NOTICE_DE)
        add(Issue("R-286-NOTICE", INFO, "notes", "Sec. 286(3) BGB",
                  "Your customer is a consumer. The 30-day late payment rule only applies if the invoice says so.",
                  "Added automatically."))
        if facts.property_work:
            result.notes_to_print.append(RETENTION_NOTE_DE)
            add(Issue("R-14-9-RETENTION", INFO, "notes", "Sec. 14(4) no. 9 and Sec. 14b(1) UStG",
                      "Private customers must keep invoices for work on a building for two years, "
                      "and the invoice has to tell them.", "Added automatically."))
    elif not facts.seller_small_business and not small_invoice:
        add(Issue("R-EINVOICE", INFO, "format", "Sec. 14 UStG, Sec. 27(38) UStG",
                  "Business customers in Germany must be able to receive e-invoices. Sending them becomes "
                  "mandatory from 2027 (over 800,000 EUR turnover) or 2028.",
                  "PaidLoop creates a ZUGFeRD e-invoice for you."))

    return result
