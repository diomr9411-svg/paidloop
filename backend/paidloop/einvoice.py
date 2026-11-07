"""Creates the legal e-invoice: a ZUGFeRD PDF (EN 16931 profile) with the XML inside.

Each XML is checked against the official schema and the official EN 16931 business rules
before it is used. The rules file comes from the EU project eInvoicing-EN16931 (EUPL 1.2).
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import reportlab
from drafthorse.models.accounting import ApplicableTradeTax
from drafthorse.models.document import Document
from drafthorse.models.note import IncludedNote
from drafthorse.models.party import TaxRegistration
from drafthorse.models.payment import PaymentMeans, PaymentTerms
from drafthorse.models.tradelines import LineItem
from drafthorse.pdf import attach_xml
from PIL import Image, ImageCms
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from paidloop.compliance import InvoiceFacts, vat_groups
from paidloop.money import eur_de, to_decimal

SMALL_BUSINESS_REASON = "Kleinunternehmer gemäß § 19 UStG"


class EInvoiceInvalid(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class EInvoice:
    xml: bytes
    pdf: bytes
    rules_checked: int


def _qty(milli: int) -> Decimal:
    return (Decimal(milli) / 1000).quantize(Decimal("0.001"))


def build_xml(
    facts: InvoiceFacts,
    number: str,
    units: tuple[str, ...],
    notes: list[str],
    pay_link: str | None,
) -> bytes:
    doc = Document()
    doc.context.guideline_parameter.id = "urn:cen.eu:en16931:2017"
    doc.header.id = number
    doc.header.type_code = "380"
    doc.header.issue_date_time = facts.issue_date
    for text in notes:
        note = IncludedNote()
        note.content = text
        doc.header.notes.add(note)

    seller = doc.trade.agreement.seller
    seller.name = facts.seller.name
    seller.address.line_one = facts.seller.street
    seller.address.postcode = facts.seller.postcode
    seller.address.city_name = facts.seller.city
    seller.address.country_id = facts.seller.country or "DE"
    if facts.seller_vat_id:
        seller.tax_registrations.add(TaxRegistration(id=("VA", facts.seller_vat_id)))
    if facts.seller_tax_number:
        seller.tax_registrations.add(TaxRegistration(id=("FC", facts.seller_tax_number)))
        if not facts.seller_vat_id:
            # Rule BR-CO-26 needs a seller ID. Many small businesses only have a tax number.
            seller.id = facts.seller_tax_number

    buyer = doc.trade.agreement.buyer
    buyer.name = facts.buyer.name
    buyer.address.line_one = facts.buyer.street
    buyer.address.postcode = facts.buyer.postcode
    buyer.address.city_name = facts.buyer.city
    buyer.address.country_id = facts.buyer.country or "DE"

    if facts.service_date:
        doc.trade.delivery.event.occurrence = facts.service_date

    settlement = doc.trade.settlement
    settlement.currency_code = "EUR"
    means = PaymentMeans()
    means.type_code = "68"  # online payment service
    means.information.add("PayPal")
    settlement.payment_means.add(means)

    terms = PaymentTerms()
    text = f"Zahlbar bis {facts.due_date:%d.%m.%Y}."
    if pay_link:
        text += f" Online bezahlen: {pay_link}"
    terms.description = text
    terms.due = facts.due_date
    settlement.terms.add(terms)

    category = "E" if facts.seller_small_business else "S"
    for position, (line, unit) in enumerate(zip(facts.lines, units), start=1):
        item = LineItem()
        item.document.line_id = str(position)
        item.product.name = line.description
        item.agreement.gross.amount = to_decimal(line.unit_price_cents)
        item.agreement.net.amount = to_decimal(line.unit_price_cents)
        item.delivery.billed_quantity = (_qty(line.quantity_milli), unit)
        item.settlement.trade_tax.type_code = "VAT"
        item.settlement.trade_tax.category_code = category
        item.settlement.trade_tax.rate_applicable_percent = Decimal(line.vat_bp) / 100
        item.settlement.monetary_summation.total_amount = to_decimal(line.net_cents)
        doc.trade.items.add(item)

    for vat_bp, (net, vat) in sorted(vat_groups(facts.lines).items()):
        tax = ApplicableTradeTax()
        tax.calculated_amount = to_decimal(vat)
        tax.basis_amount = to_decimal(net)
        tax.type_code = "VAT"
        tax.category_code = category
        if facts.seller_small_business:
            tax.exemption_reason = SMALL_BUSINESS_REASON
        tax.rate_applicable_percent = Decimal(vat_bp) / 100
        settlement.trade_tax.add(tax)

    net_total = sum(line.net_cents for line in facts.lines)
    total = settlement.monetary_summation
    total.line_total = to_decimal(net_total)
    total.charge_total = to_decimal(0)
    total.allowance_total = to_decimal(0)
    total.tax_basis_total = to_decimal(net_total)
    total.tax_total = (to_decimal(facts.vat_cents), "EUR")
    total.grand_total = to_decimal(facts.gross_cents)
    total.due_amount = to_decimal(facts.gross_cents)

    # serialize() checks the XML against the official XSD and raises if it does not fit.
    return doc.serialize(schema="FACTUR-X_EN16931")


class _RulesWorker:
    """Keeps the official rules running in a separate process, so a crash there can't stop the app."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None

    def _start(self) -> subprocess.Popen:
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        return subprocess.Popen(
            [sys.executable, "-m", "paidloop.rules_worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=flags,
        )

    def check(self, xml: bytes) -> dict:
        with self._lock:
            for _attempt in range(2):
                if self._process is None or self._process.poll() is not None:
                    self._process = self._start()
                try:
                    self._process.stdin.write(str(len(xml)).encode() + b"\n" + xml)
                    self._process.stdin.flush()
                    line = self._process.stdout.readline()
                    if line:
                        return json.loads(line)
                except (OSError, ValueError):
                    pass
                self.stop()
        # Fail closed: without a working check, no invoice goes out.
        return {"problems": ["The official rule check could not run."], "checked": 0}

    def stop(self) -> None:
        process, self._process = self._process, None
        if process and process.poll() is None:
            process.kill()


_worker = _RulesWorker()
atexit.register(_worker.stop)


def validate_rules(xml: bytes) -> tuple[list[str], int]:
    """Run the official EN 16931 rules. Returns (fatal problems, number of rules checked)."""
    answer = _worker.check(xml)
    return answer["problems"], answer["checked"]


def _register_fonts() -> None:
    if "Vera" not in pdfmetrics.getRegisteredFontNames():
        fonts = Path(reportlab.__file__).parent / "fonts"
        pdfmetrics.registerFont(TTFont("Vera", fonts / "Vera.ttf"))
        pdfmetrics.registerFont(TTFont("VeraBd", fonts / "VeraBd.ttf"))


def build_pdf(
    facts: InvoiceFacts,
    number: str,
    notes: list[str],
    pay_link: str | None,
    qr_png: bytes | None,
) -> bytes:
    """The readable part of the invoice. It is in German, because that is what the customer needs."""
    _register_fonts()
    buffer = BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4, invariant=1)
    page.setTitle(f"Rechnung {number}")
    page.setAuthor(facts.seller.name)
    page.setSubject("Rechnung")
    left, right = 55, 540
    y = 790

    page.setFont("VeraBd", 13)
    page.drawString(left, y, facts.seller.name)
    page.setFont("Vera", 9)
    y -= 14
    page.drawString(left, y, f"{facts.seller.street}, {facts.seller.postcode} {facts.seller.city}")
    tax_id = f"USt-IdNr.: {facts.seller_vat_id}" if facts.seller_vat_id else f"Steuernummer: {facts.seller_tax_number}"
    y -= 12
    page.drawString(left, y, tax_id)

    y -= 42
    page.setFont("Vera", 10)
    for text in [facts.buyer.name, facts.buyer.street, f"{facts.buyer.postcode} {facts.buyer.city}".strip()]:
        if text:
            page.drawString(left, y, text)
            y -= 14

    y -= 16
    page.setFont("VeraBd", 16)
    page.drawString(left, y, f"Rechnung {number}")
    y -= 20
    page.setFont("Vera", 9)
    service = f"Leistungsdatum: {facts.service_date:%d.%m.%Y}   " if facts.service_date else ""
    page.drawString(left, y, f"Rechnungsdatum: {facts.issue_date:%d.%m.%Y}   {service}Zahlbar bis: {facts.due_date:%d.%m.%Y}")

    y -= 28
    page.setFont("VeraBd", 9)
    page.drawString(left, y, "Pos.  Beschreibung")
    page.drawRightString(390, y, "Menge")
    page.drawRightString(460, y, "Einzelpreis")
    page.drawRightString(right, y, "Netto")
    y -= 5
    page.line(left, y, right, y)
    page.setFont("Vera", 9)
    for position, line in enumerate(facts.lines, start=1):
        wrapped = simpleSplit(line.description, "Vera", 9, 270) or [""]
        y -= 14
        page.drawString(left, y, f"{position}")
        page.drawString(left + 28, y, wrapped[0])
        page.drawRightString(390, y, f"{_qty(line.quantity_milli).normalize():f}")
        page.drawRightString(460, y, eur_de(line.unit_price_cents))
        page.drawRightString(right, y, eur_de(line.net_cents))
        for extra in wrapped[1:]:
            y -= 12
            page.drawString(left + 28, y, extra)

    y -= 8
    page.line(left, y, right, y)
    y -= 16
    page.drawRightString(460, y, "Summe netto")
    page.drawRightString(right, y, eur_de(sum(line.net_cents for line in facts.lines)))
    if not facts.seller_small_business:
        for vat_bp, (_net, vat) in sorted(vat_groups(facts.lines).items()):
            y -= 14
            page.drawRightString(460, y, f"USt. {Decimal(vat_bp) / 100:.0f} %")
            page.drawRightString(right, y, eur_de(vat))
    y -= 18
    page.setFont("VeraBd", 11)
    page.drawRightString(460, y, "Gesamtbetrag")
    page.drawRightString(right, y, eur_de(facts.gross_cents))

    y -= 32
    page.setFont("Vera", 9)
    for text in notes:
        for wrapped_line in simpleSplit(text, "Vera", 9, right - left):
            page.drawString(left, y, wrapped_line)
            y -= 12
        y -= 4

    if pay_link:
        y -= 8
        page.setFont("VeraBd", 10)
        page.drawString(left, y, "Online bezahlen mit PayPal")
        page.setFont("Vera", 8)
        y -= 13
        for wrapped_line in simpleSplit(pay_link, "Vera", 8, 340):
            page.drawString(left, y, wrapped_line)
            y -= 10
        if qr_png:
            image = Image.open(BytesIO(qr_png)).convert("RGB")
            page.drawImage(ImageReader(image), 440, y - 60, width=100, height=100)

    page.setFont("Vera", 7)
    page.drawString(left, 40, "Erstellt mit PaidLoop. Keine Steuer- oder Rechtsberatung.")
    page.save()
    return buffer.getvalue()


def _add_output_intent(pdf: bytes) -> bytes:
    """PDF/A needs a colour profile. Pillow creates a free sRGB profile."""
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    writer = PdfWriter(clone_from=PdfReader(BytesIO(pdf)))
    stream = DecodedStreamObject()
    stream.set_data(profile)
    stream[NameObject("/N")] = NumberObject(3)
    intent = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/OutputIntent"),
            NameObject("/S"): NameObject("/GTS_PDFA1"),
            NameObject("/OutputConditionIdentifier"): TextStringObject("sRGB"),
            NameObject("/Info"): TextStringObject("sRGB"),
            NameObject("/DestOutputProfile"): writer._add_object(stream),
        }
    )
    writer._root_object[NameObject("/OutputIntents")] = ArrayObject([writer._add_object(intent)])
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def create(
    facts: InvoiceFacts,
    number: str,
    units: tuple[str, ...],
    notes: list[str],
    pay_link: str | None,
    qr_png: bytes | None = None,
) -> EInvoice:
    """Build and validate. Raises EInvoiceInvalid rather than ever returning a broken invoice."""
    try:
        xml = build_xml(facts, number, units, notes, pay_link)
    except Exception as error:  # the library reports schema problems with several error types
        raise EInvoiceInvalid([f"Schema: {error}"]) from error
    problems, checked = validate_rules(xml)
    if problems:
        raise EInvoiceInvalid(problems)
    visual = _add_output_intent(build_pdf(facts, number, notes, pay_link, qr_png))
    return EInvoice(xml=xml, pdf=attach_xml(visual, xml, level="EN 16931"), rules_checked=checked)


def read_back_xml(pdf: bytes) -> bytes | None:
    attachments = PdfReader(BytesIO(pdf)).attachments
    files = attachments.get("factur-x.xml")
    return files[0] if files else None
