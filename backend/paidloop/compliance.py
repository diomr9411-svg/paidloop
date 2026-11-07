"""Checks an invoice against German rules. Fixed code with tests, never AI. Not tax or legal advice.

Sources: Sec. 14(4) UStG (required fields), Sec. 19 UStG (small business), Sec. 33 UStDV (small
invoices up to 250 EUR gross), Sec. 14b(1) UStG (keeping invoices for work on property), Sec. 286(3)
BGB (consumer notice). Every message exists in English and German.
"""

import re
from dataclasses import dataclass, field
from datetime import date

from paidloop.i18n import Text
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
CONSUMER_NOTICE_EN = (
    "Note: you will be in default at the latest 30 days after the due date and receipt of this invoice "
    "if you do not pay (Sec. 286(3) German Civil Code)."
)
SMALL_BUSINESS_NOTE_DE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
SMALL_BUSINESS_NOTE_EN = "No VAT is charged under Sec. 19 of the German VAT Act (small business)."
RETENTION_NOTE_DE = "Bitte bewahren Sie diese Rechnung zwei Jahre auf (§ 14b Abs. 1 Satz 5 UStG)."
RETENTION_NOTE_EN = "Please keep this invoice for two years (Sec. 14b(1) sentence 5 of the German VAT Act)."


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
    buyer_language: str = "de"


@dataclass(frozen=True)
class Issue:
    rule_id: str
    severity: str
    field: str
    law: str
    message: Text
    fix: Text


@dataclass
class CheckResult:
    issues: list[Issue] = field(default_factory=list)
    notes_to_print: list[str] = field(default_factory=list)

    @property
    def can_issue(self) -> bool:
        return not any(issue.severity == ERROR for issue in self.issues)


def law_in_german(law: str) -> str:
    """Sec. 14(4) no. 5 UStG becomes § 14 Abs. 4 Nr. 5 UStG, as German readers expect."""
    text = re.sub(r"Sec\. (\d+\w*)\((\d+)\)", r"§ \1 Abs. \2", law)
    text = text.replace("Sec. ", "§ ").replace(" no. ", " Nr. ").replace(" sentence ", " Satz ").replace(" and ", " und ")
    return "PayPal-Rechnungen" if text == "PayPal invoicing" else text


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
    german = facts.buyer_language != "en"

    if not facts.seller.has_full_address:
        add(Issue("R-14-1-SELLER", ERROR, "seller", "Sec. 14(4) no. 1 UStG",
                  Text("Your full name and address are missing.", "Ihr vollständiger Name und Ihre Anschrift fehlen."),
                  Text("Add them in your business settings.", "Tragen Sie beides in den Einstellungen ein.")))

    if not facts.buyer.name.strip():
        add(Issue("R-14-1-BUYER", ERROR, "buyer.name", "Sec. 14(4) no. 1 UStG",
                  Text("The customer's name is missing.", "Der Name des Kunden fehlt."),
                  Text("Add the customer's full name.", "Tragen Sie den vollständigen Namen ein.")))
    elif not facts.buyer.has_full_address:
        if small_invoice:
            add(Issue("R-33-BUYER", INFO, "buyer.address", "Sec. 33 UStDV",
                      Text("Invoices up to 250 EUR gross can leave out the customer's address.",
                           "Rechnungen bis 250 EUR brutto dürfen ohne Kundenanschrift ausgestellt werden."),
                      Text("You can still add it, as this helps with reminders.",
                           "Sie können sie trotzdem eintragen, das hilft bei Erinnerungen.")))
        else:
            add(Issue("R-14-1-BUYER-ADDRESS", ERROR, "buyer.address", "Sec. 14(4) no. 1 UStG",
                      Text("The customer's full address is missing.", "Die vollständige Anschrift des Kunden fehlt."),
                      Text("Add street, postcode and city.", "Tragen Sie Straße, PLZ und Ort ein.")))

    if not (facts.seller_vat_id.strip() or facts.seller_tax_number.strip()) and not small_invoice:
        add(Issue("R-14-2-TAX-ID", ERROR, "seller.tax", "Sec. 14(4) no. 2 UStG",
                  Text("Your tax number or VAT ID is missing.", "Ihre Steuernummer oder USt-IdNr. fehlt."),
                  Text("Add one in your business settings.", "Tragen Sie eine davon in den Einstellungen ein.")))

    if facts.issue_date is None:
        add(Issue("R-14-3-DATE", ERROR, "issue_date", "Sec. 14(4) no. 3 UStG",
                  Text("The issue date is missing.", "Das Rechnungsdatum fehlt."),
                  Text("Set the invoice date.", "Legen Sie das Rechnungsdatum fest.")))

    if not facts.lines:
        add(Issue("R-14-5-LINES", ERROR, "lines", "Sec. 14(4) no. 5 UStG",
                  Text("The invoice has no items.", "Die Rechnung hat keine Positionen."),
                  Text("Add at least one item.", "Fügen Sie mindestens eine Position hinzu.")))

    for position, line in enumerate(facts.lines, start=1):
        if not line.description.strip():
            add(Issue("R-14-5-DESC", ERROR, f"lines.{position}.description", "Sec. 14(4) no. 5 UStG",
                      Text(f"Item {position} does not say what was delivered or done.",
                           f"Position {position} nennt nicht, was geliefert oder geleistet wurde."),
                      Text("Describe the work or goods.", "Beschreiben Sie die Arbeit oder Ware.")))
        if line.quantity_milli <= 0:
            add(Issue("R-14-5-QTY", ERROR, f"lines.{position}.quantity", "Sec. 14(4) no. 5 UStG",
                      Text(f"Item {position} has no quantity.", f"Position {position} hat keine Menge."),
                      Text("Enter a quantity above zero.", "Tragen Sie eine Menge über null ein.")))
        if line.unit_price_cents <= 0:
            add(Issue("R-PRICE", ERROR, f"lines.{position}.price", "Sec. 14(4) no. 7 UStG",
                      Text(f"Item {position} has no price.", f"Position {position} hat keinen Preis."),
                      Text("Enter a price above zero.", "Tragen Sie einen Preis über null ein.")))
        if line.net_cents != line_net(line.quantity_milli, line.unit_price_cents):
            add(Issue("R-MATH-LINE", ERROR, f"lines.{position}.net", "Sec. 14(4) no. 7 UStG",
                      Text(f"Item {position}: quantity times price does not match its total.",
                           f"Position {position}: Menge mal Preis passt nicht zur Summe."),
                      Text("Recalculate this item.", "Berechnen Sie diese Position neu.")))

    if facts.service_date is None and not small_invoice:
        add(Issue("R-14-6-SERVICE-DATE", ERROR, "service_date", "Sec. 14(4) no. 6 UStG",
                  Text("The date of the work or delivery is missing.", "Das Leistungsdatum fehlt."),
                  Text("Enter when the work was done.", "Tragen Sie ein, wann die Arbeit erledigt wurde.")))

    if facts.seller_small_business:
        if facts.vat_cents != 0 or any(line.vat_bp != 0 for line in facts.lines):
            add(Issue("R-19-NO-VAT", ERROR, "vat", "Sec. 19 UStG, Sec. 14c UStG",
                      Text("As a small business you must not show VAT. VAT shown by mistake can still be owed.",
                           "Als Kleinunternehmer dürfen Sie keine Umsatzsteuer ausweisen. Falsch ausgewiesene Steuer kann trotzdem geschuldet sein."),
                      Text("Set VAT to 0% on all items.", "Setzen Sie die Umsatzsteuer bei allen Positionen auf 0 %.")))
        result.notes_to_print.append(SMALL_BUSINESS_NOTE_DE if german else SMALL_BUSINESS_NOTE_EN)
    else:
        for position, line in enumerate(facts.lines, start=1):
            if line.vat_bp not in ALLOWED_VAT_BP:
                add(Issue("R-14-8-RATE", ERROR, f"lines.{position}.vat", "Sec. 14(4) no. 8 UStG",
                          Text(f"Item {position}: only 19% and 7% are supported here.",
                               f"Position {position}: Hier werden nur 19 % und 7 % unterstützt."),
                          Text("Choose 19% or 7%. Ask a tax adviser about exempt sales.",
                               "Wählen Sie 19 % oder 7 %. Fragen Sie bei steuerfreien Umsätzen Ihre Steuerberatung.")))
        groups = vat_groups(facts.lines)
        if facts.vat_cents != sum(vat for _, vat in groups.values()):
            add(Issue("R-MATH-VAT", ERROR, "vat", "Sec. 14(4) no. 8 UStG",
                      Text("The VAT total does not match the items.", "Die Umsatzsteuer passt nicht zu den Positionen."),
                      Text("Recalculate the invoice.", "Berechnen Sie die Rechnung neu.")))

    if facts.gross_cents != net_total + facts.vat_cents:
        add(Issue("R-MATH-TOTAL", ERROR, "gross", "Sec. 14(4) no. 7 and 8 UStG",
                  Text("Net plus VAT does not equal the total.", "Netto plus Umsatzsteuer ergibt nicht die Summe."),
                  Text("Recalculate the invoice.", "Berechnen Sie die Rechnung neu.")))

    if facts.due_date is None:
        add(Issue("R-DUE", ERROR, "due_date", "Sec. 286 BGB",
                  Text("There is no payment date, so reminders cannot be timed.",
                       "Es gibt kein Zahlungsziel, daher lassen sich Erinnerungen nicht planen."),
                  Text("Set a due date.", "Legen Sie ein Fälligkeitsdatum fest.")))
    elif facts.issue_date and facts.due_date < facts.issue_date:
        add(Issue("R-DUE-ORDER", ERROR, "due_date", "Sec. 286 BGB",
                  Text("The due date is before the invoice date.", "Das Fälligkeitsdatum liegt vor dem Rechnungsdatum."),
                  Text("Correct the due date.", "Korrigieren Sie das Fälligkeitsdatum.")))

    if not facts.buyer.email.strip():
        add(Issue("R-EMAIL", ERROR, "buyer.email", "PayPal invoicing",
                  Text("The customer's email is missing, so PayPal cannot link the payment request.",
                       "Die E-Mail des Kunden fehlt, daher kann PayPal die Zahlungsaufforderung nicht zuordnen."),
                  Text("Add the customer's email.", "Tragen Sie die E-Mail des Kunden ein.")))

    if not facts.buyer_is_business:
        result.notes_to_print.append(CONSUMER_NOTICE_DE if german else CONSUMER_NOTICE_EN)
        add(Issue("R-286-NOTICE", INFO, "notes", "Sec. 286(3) BGB",
                  Text("Your customer is a consumer. The 30-day late payment rule only applies if the invoice says so.",
                       "Ihr Kunde ist Verbraucher. Die 30-Tage-Regel gilt nur, wenn die Rechnung darauf hinweist."),
                  Text("Added automatically.", "Wurde automatisch ergänzt.")))
        if facts.property_work:
            result.notes_to_print.append(RETENTION_NOTE_DE if german else RETENTION_NOTE_EN)
            add(Issue("R-14-9-RETENTION", INFO, "notes", "Sec. 14(4) no. 9 and Sec. 14b(1) UStG",
                      Text("Private customers must keep invoices for work on a building for two years, and the invoice has to tell them.",
                           "Privatkunden müssen Rechnungen für Arbeiten am Gebäude zwei Jahre aufbewahren, und die Rechnung muss darauf hinweisen."),
                      Text("Added automatically.", "Wurde automatisch ergänzt.")))
    elif not facts.seller_small_business and not small_invoice:
        add(Issue("R-EINVOICE", INFO, "format", "Sec. 14 UStG, Sec. 27(38) UStG",
                  Text("Business customers in Germany must be able to receive e-invoices. Sending them becomes "
                       "mandatory from 2027 (over 800,000 EUR turnover) or 2028.",
                       "Geschäftskunden in Deutschland müssen E-Rechnungen empfangen können. Der Versand wird ab 2027 "
                       "(über 800.000 EUR Umsatz) oder 2028 Pflicht."),
                  Text("PaidLoop creates a ZUGFeRD e-invoice for you.", "PaidLoop erstellt für Sie eine ZUGFeRD-E-Rechnung.")))

    return result
