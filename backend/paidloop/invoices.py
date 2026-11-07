"""The invoice lifecycle: draft, check, issue, payments and cancellation."""

from __future__ import annotations

import secrets
import threading
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from paidloop import audit, compliance, einvoice, ledger
from paidloop.compliance import CheckResult, InvoiceFacts, Line, Party, vat_groups
from paidloop.i18n import LocalizedError, Text
from paidloop.models import (
    CANCELLED,
    CHECKED,
    DISPUTED,
    DRAFT,
    ISSUED,
    OPEN_STATES,
    PAID,
    AppState,
    Business,
    Customer,
    Invoice,
    InvoiceLine,
    Payment,
)
from paidloop.money import line_net, percent_of
from paidloop.paypal import InvoiceState, PaymentRequest, PayPalError, RequestLine

_issue_lock = threading.Lock()


class InvoiceError(LocalizedError):
    """A problem the owner can understand and fix."""


# Demo clock


def offset_days(session: Session) -> int:
    row = session.get(AppState, "clock_offset_days")
    return int(row.value) if row else 0


def today(session: Session) -> date:
    return date.today() + timedelta(days=offset_days(session))


def set_offset(session: Session, days: int) -> None:
    row = session.get(AppState, "clock_offset_days")
    if row:
        row.value = str(days)
    else:
        session.add(AppState(key="clock_offset_days", value=str(days)))


# Reading


def business_of(session: Session) -> Business:
    business = session.scalar(select(Business).limit(1))
    if business is None:
        business = Business()
        session.add(business)
        session.flush()
    return business


def facts_for(invoice: Invoice, business: Business) -> InvoiceFacts:
    customer = invoice.customer
    return InvoiceFacts(
        seller=Party(business.name, business.street, business.postcode, business.city, business.country, business.email),
        buyer=Party(customer.name, customer.street, customer.postcode, customer.city, customer.country, customer.email)
        if customer
        else Party(),
        seller_vat_id=business.vat_id,
        seller_tax_number=business.tax_number,
        seller_small_business=business.small_business,
        buyer_is_business=customer.is_business if customer else True,
        issue_date=invoice.issue_date,
        service_date=invoice.service_date,
        due_date=invoice.due_date,
        property_work=invoice.property_work,
        lines=tuple(Line(l.description, l.quantity_milli, l.unit_price_cents, l.vat_bp, l.net_cents) for l in invoice.lines),
        vat_cents=invoice.vat_cents,
        gross_cents=invoice.gross_cents,
        buyer_language=customer.language if customer else "de",
    )


# Drafts


@dataclass(frozen=True)
class LineInput:
    description: str
    quantity_milli: int
    unit: str
    unit_price_cents: int
    vat_bp: int


def recalculate(invoice: Invoice) -> None:
    for position, line in enumerate(invoice.lines, start=1):
        line.position = position
        line.net_cents = line_net(line.quantity_milli, line.unit_price_cents)
    facts = [Line(l.description, l.quantity_milli, l.unit_price_cents, l.vat_bp, l.net_cents) for l in invoice.lines]
    invoice.net_cents = sum(l.net_cents for l in invoice.lines)
    invoice.vat_cents = sum(vat for _, vat in vat_groups(facts).values())
    invoice.gross_cents = invoice.net_cents + invoice.vat_cents


def save_draft(
    session: Session,
    invoice: Invoice | None,
    customer_id: int | None,
    lines: list[LineInput],
    issue_date: date | None,
    service_date: date | None,
    due_date: date | None,
    property_work: bool,
    source_text: str = "",
    capture_source: str = "manual",
) -> Invoice:
    if invoice is None:
        invoice = Invoice(status=DRAFT, source_text=source_text, capture_source=capture_source)
        session.add(invoice)
    elif invoice.status not in {DRAFT, CHECKED}:
        raise InvoiceError(Text("An issued invoice can't be changed. Cancel it and create a new one.",
                                "Eine ausgestellte Rechnung kann nicht geändert werden. Stornieren Sie sie und erstellen Sie eine neue."))
    invoice.status = DRAFT
    invoice.customer = session.get(Customer, customer_id) if customer_id else None
    business = business_of(session)
    invoice.issue_date = issue_date
    invoice.service_date = service_date
    invoice.due_date = due_date
    invoice.property_work = property_work
    invoice.lines = [
        InvoiceLine(
            description=l.description.strip(),
            quantity_milli=l.quantity_milli,
            unit=l.unit if l.unit in {"HUR", "H87"} else "H87",
            unit_price_cents=l.unit_price_cents,
            vat_bp=0 if business.small_business else l.vat_bp,
        )
        for l in lines
    ]
    recalculate(invoice)
    session.flush()
    audit.record(session, "owner", "draft_saved", invoice.id, gross_cents=invoice.gross_cents)
    return invoice


def run_check(session: Session, invoice: Invoice) -> CheckResult:
    if invoice.status not in {DRAFT, CHECKED}:
        raise InvoiceError(Text("Only drafts are checked.", "Nur Entwürfe werden geprüft."))
    business = business_of(session)
    result = compliance.check(facts_for(invoice, business))
    invoice.status = CHECKED if result.can_issue else DRAFT
    audit.record(session, "rules", "checked", invoice.id, can_issue=result.can_issue,
                 errors=[i.rule_id for i in result.issues if i.severity == compliance.ERROR])
    return result


# Issuing


def _request_lines(invoice: Invoice) -> tuple[RequestLine, ...]:
    """Use the items if PayPal's per-item VAT adds up to ours, otherwise one line per VAT rate.

    A legal invoice works out VAT per rate, but PayPal rounds per item. The two can differ by a cent,
    and then the customer would be asked to pay a different amount from the invoice.
    """
    per_item_vat = sum(percent_of(line.net_cents, line.vat_bp) for line in invoice.lines)
    if per_item_vat == invoice.vat_cents and all(line.quantity_milli % 10 == 0 for line in invoice.lines):
        return tuple(
            RequestLine(
                name=line.description,
                quantity=f"{Decimal(line.quantity_milli) / 1000:f}".rstrip("0").rstrip(".") or "0",
                unit_price_cents=line.unit_price_cents,
                vat_percent=f"{Decimal(line.vat_bp) / 100:f}".rstrip("0").rstrip(".") if line.vat_bp else None,
                hours=line.unit == "HUR",
            )
            for line in invoice.lines
        )
    groups = vat_groups([Line(l.description, l.quantity_milli, l.unit_price_cents, l.vat_bp, l.net_cents) for l in invoice.lines])
    return tuple(
        RequestLine(
            name=(f"Invoice {invoice.number}" + (f" ({Decimal(bp) / 100:.0f}% VAT)" if bp else ""))
            if invoice.customer and invoice.customer.language == "en"
            else (f"Rechnung {invoice.number}" + (f" ({Decimal(bp) / 100:.0f}% USt.)" if bp else "")),
            quantity="1",
            unit_price_cents=net,
            vat_percent=f"{Decimal(bp) / 100:f}".rstrip("0").rstrip(".") if bp else None,
        )
        for bp, (net, _vat) in sorted(groups.items())
    )


def issue(session: Session, invoice: Invoice, paypal, public_base: str) -> Invoice:
    """Issue the legal e-invoice and PayPal payment request together.

    If anything fails, the caller rolls back, so the invoice number stays unused and numbers have no gaps.
    """
    with _issue_lock:
        session.refresh(invoice)
        if invoice.status != CHECKED:
            raise InvoiceError(Text("Run the check first. Only a checked invoice can be issued.",
                                    "Bitte zuerst prüfen. Nur eine geprüfte Rechnung kann ausgestellt werden."))
        business = business_of(session)
        session.refresh(business)
        result = compliance.check(facts_for(invoice, business))
        if not result.can_issue:
            invoice.status = DRAFT
            raise InvoiceError(Text("The invoice no longer passes the check.", "Die Rechnung besteht die Prüfung nicht mehr."))

        year = invoice.issue_date.year
        number = f"{business.invoice_prefix}-{year}-{business.next_number:04d}"
        units = tuple(line.unit for line in invoice.lines)
        facts = facts_for(invoice, business)

        # Check first, so PayPal never gets a request for an invoice that would fail the official rules.
        try:
            einvoice.create(facts, number, units, result.notes_to_print, None)
        except einvoice.EInvoiceInvalid as error:
            raise InvoiceError(Text(f"The e-invoice failed the official rules: {error}",
                                    f"Die E-Rechnung hat die offiziellen Regeln nicht bestanden: {error}")) from error

        invoice.number = number
        invoice.public_token = secrets.token_urlsafe(24)
        paypal_number = number + (f"-{business.paypal_suffix}" if business.paypal_suffix else "")
        customer = invoice.customer
        request = PaymentRequest(
            number=paypal_number,
            issue_date=invoice.issue_date,
            due_date=invoice.due_date,
            note=f"Payment request for invoice {number}. You receive the invoice itself as an e-invoice (ZUGFeRD). "
            f"This is not a second invoice."
            if customer.language == "en"
            else f"Zahlungsaufforderung zu Rechnung {number}. Die Rechnung selbst erhalten Sie als E-Rechnung (ZUGFeRD). "
            f"Dies ist keine zweite Rechnung.",
            recipient_name=customer.name,
            recipient_email=customer.email,
            lines=_request_lines(invoice),
            invoicer_name=business.name,
        )
        paypal_id = None
        try:
            paypal_id = paypal.create_invoice(request)
            paypal.send(paypal_id)
            state = paypal.get(paypal_id)
            if state.due_cents != invoice.gross_cents:
                raise InvoiceError(
                    Text(f"PayPal calculated {state.due_cents} cents but the invoice says {invoice.gross_cents}. Nothing was issued.",
                         f"PayPal hat {state.due_cents} Cent berechnet, die Rechnung nennt {invoice.gross_cents}. Es wurde nichts ausgestellt.")
                )
            try:
                qr = paypal.qr_code(paypal_id)
            except PayPalError:
                qr = None  # the link still works without the picture
            final = einvoice.create(facts, number, units, result.notes_to_print, state.pay_link, qr)
        except (PayPalError, einvoice.EInvoiceInvalid, InvoiceError) as error:
            if paypal_id:
                _try_cancel(paypal, paypal_id)
            if isinstance(error, InvoiceError):
                raise
            raise InvoiceError(Text(f"Issuing failed, nothing was issued: {error}",
                                    f"Das Ausstellen ist fehlgeschlagen, es wurde nichts ausgestellt: {error}")) from error

        invoice.paypal_id = paypal_id
        invoice.paypal_number = paypal_number
        invoice.pay_link = state.pay_link
        invoice.qr_png = qr
        invoice.xml = final.xml
        invoice.pdf = final.pdf
        invoice.move_to(ISSUED)
        business.next_number += 1

        vat_account = ledger.VAT_DEFERRED if business.vat_method == "ist" else ledger.VAT_PAYABLE
        ledger.post(
            session,
            f"issue:{invoice.id}",
            f"Invoice {number}",
            invoice.issue_date,
            [
                (ledger.RECEIVABLE, invoice.gross_cents, 0),
                (ledger.REVENUE, 0, invoice.net_cents),
                (vat_account, 0, invoice.vat_cents),
            ],
            invoice.id,
        )
        audit.record(session, "owner", "issued", invoice.id, number=number, gross_cents=invoice.gross_cents,
                     paypal_id=paypal_id, official_rules_checked=final.rules_checked)
        # Save before the lock opens. Otherwise the next invoice could read the old number.
        session.commit()
        return invoice


def _try_cancel(paypal, paypal_id: str) -> None:
    try:
        paypal.cancel(paypal_id, "Replaced")
    except PayPalError:
        pass


# Payments


def apply_state(session: Session, invoice: Invoice, state: InvoiceState, on: date) -> int:
    """Record new payments from PayPal. Safe to run any number of times. Returns the new amount."""
    new_cents = 0
    for transaction in state.transactions:
        known = session.scalar(select(Payment.id).where(Payment.external_id == transaction.external_id))
        if known:
            continue
        invoice.payments.append(
            Payment(external_id=transaction.external_id, amount_cents=transaction.amount_cents,
                    paid_on=transaction.paid_on, method=transaction.method)
        )
        invoice.paid_cents += transaction.amount_cents
        new_cents += transaction.amount_cents
        ledger.post(session, f"payment:{transaction.external_id}", f"Payment for {invoice.number}", transaction.paid_on,
                    [(ledger.CASH, transaction.amount_cents, 0), (ledger.RECEIVABLE, 0, transaction.amount_cents)],
                    invoice.id)
        _release_cash_basis_vat(session, invoice, transaction.external_id, transaction.amount_cents, transaction.paid_on)
        audit.record(session, "paypal", "payment_received", invoice.id, amount_cents=transaction.amount_cents,
                     paypal_payment_id=transaction.external_id, open_cents=invoice.open_cents)
    return new_cents


def _release_cash_basis_vat(session: Session, invoice: Invoice, key: str, amount: int, on: date) -> None:
    """With cash-basis VAT (Ist), tax becomes due only when the customer pays."""
    if business_of(session).vat_method != "ist" or not invoice.vat_cents or not invoice.gross_cents:
        return
    if invoice.paid_cents >= invoice.gross_cents:
        share = invoice.vat_cents - _released_vat(session, invoice)
    else:
        share = amount * invoice.vat_cents // invoice.gross_cents
    if share > 0:
        ledger.post(session, f"vat-release:{key}", f"VAT due for {invoice.number}", on,
                    [(ledger.VAT_DEFERRED, share, 0), (ledger.VAT_PAYABLE, 0, share)], invoice.id)


def _released_vat(session: Session, invoice: Invoice) -> int:
    from paidloop.models import JournalEntry, JournalLine

    rows = session.scalars(
        select(JournalLine.credit_cents)
        .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
        .where(JournalEntry.invoice_id == invoice.id, JournalLine.account == ledger.VAT_PAYABLE)
    )
    return sum(rows)


def sync(session: Session, invoice: Invoice, paypal) -> int:
    """Ask PayPal about this invoice and its plan payments, then update everything."""
    if invoice.status not in OPEN_STATES or not invoice.paypal_id:
        return 0
    on = today(session)
    # Ask PayPal first, so no database lock is held during the slow network calls.
    main_state = paypal.get(invoice.paypal_id)
    plan_states = [
        (installment, paypal.get(installment.paypal_id))
        for plan in invoice.plans
        if plan.status in {"active", "done"}
        for installment in plan.installments
        if installment.paypal_id
    ]
    # The background check, the customer page and a webhook can all run at once. Taking the write
    # lock and then reading fresh numbers means a payment is never lost or counted twice.
    session.execute(text("INSERT OR REPLACE INTO app_state (key, value) VALUES ('sync_lock', '1')"))
    session.refresh(invoice)
    if invoice.status not in OPEN_STATES:
        return 0
    new_cents = apply_state(session, invoice, main_state, on)
    for installment, state in plan_states:
        new_cents += apply_state(session, invoice, state, on)
        installment.paid_cents = state.paid_cents
    if invoice.gross_cents and invoice.paid_cents >= invoice.gross_cents:
        close_as_paid(session, invoice, on)
    return new_cents


def close_as_paid(session: Session, invoice: Invoice, on: date) -> None:
    invoice.move_to(PAID)
    invoice.paid_on = on
    invoice.paused_until = None
    plan = invoice.active_plan
    if plan:
        plan.status = "done"
    for proposal in invoice.proposals:
        if proposal.status == "pending":
            proposal.status = "obsolete"
    audit.record(session, "paypal", "invoice_paid", invoice.id, paid_cents=invoice.paid_cents)


def cancel(session: Session, invoice: Invoice, paypal, reason: str) -> None:
    """Issued invoices are never deleted. A legal credit note (Stornorechnung) corrects them.

    Simply removing an invoice is not allowed in Germany, and VAT shown on it could still be owed.
    """
    if invoice.status not in OPEN_STATES:
        raise InvoiceError(Text("Only open invoices can be cancelled.", "Nur offene Rechnungen können storniert werden."))
    if invoice.paid_cents:
        raise InvoiceError(Text("This invoice has payments. Refund them first.", "Diese Rechnung hat Zahlungen. Erstatten Sie diese zuerst."))
    with _issue_lock:
        session.refresh(invoice)
        business = business_of(session)
        session.refresh(business)
        on = today(session)
        number = f"{business.invoice_prefix}-{on.year}-{business.next_number:04d}"
        facts = replace(facts_for(invoice, business), issue_date=on)
        notes = [
            f"Credit note for invoice {invoice.number} of {invoice.issue_date:%d.%m.%Y}."
            if invoice.customer.language == "en"
            else f"Stornorechnung zu Rechnung {invoice.number} vom {invoice.issue_date:%d.%m.%Y}."
        ]
        try:
            credit = einvoice.create(facts, number, tuple(line.unit for line in invoice.lines), notes, None,
                                     corrects=(invoice.number, invoice.issue_date))
        except einvoice.EInvoiceInvalid as error:
            raise InvoiceError(Text(f"The credit note failed the official rules: {error}",
                                    f"Die Stornorechnung hat die offiziellen Regeln nicht bestanden: {error}")) from error
        invoice.credit_note_number = number
        invoice.credit_note_xml = credit.xml
        invoice.credit_note_pdf = credit.pdf
        business.next_number += 1
        _cancel_records(session, invoice, business, paypal, on, reason)
        session.commit()


def _cancel_records(session: Session, invoice: Invoice, business: Business, paypal, on: date, reason: str) -> None:
    ids = [invoice.paypal_id] + [i.paypal_id for p in invoice.plans for i in p.installments if i.paypal_id]
    for paypal_id in ids:
        if paypal_id:
            _try_cancel(paypal, paypal_id)
    vat_account = ledger.VAT_DEFERRED if business.vat_method == "ist" else ledger.VAT_PAYABLE
    ledger.post(session, f"cancel:{invoice.id}", f"Cancelled {invoice.number}", on,
                [(ledger.REVENUE, invoice.net_cents, 0), (vat_account, invoice.vat_cents, 0),
                 (ledger.RECEIVABLE, 0, invoice.gross_cents)], invoice.id)
    invoice.move_to(CANCELLED)
    for plan in invoice.plans:
        if plan.status in {"active", "offered"}:
            plan.status = "declined"
    for proposal in invoice.proposals:
        if proposal.status == "pending":
            proposal.status = "obsolete"
    audit.record(session, "owner", "cancelled", invoice.id, reason=reason[:200], credit_note=invoice.credit_note_number)


def resume_after_dispute(session: Session, invoice: Invoice) -> None:
    if invoice.status != DISPUTED:
        raise InvoiceError(Text("This invoice is not disputed.", "Diese Rechnung ist nicht strittig."))
    invoice.move_to("on_plan" if invoice.active_plan else ISSUED)
    invoice.paused_until = None
    audit.record(session, "owner", "dispute_closed", invoice.id)


def delete_draft(session: Session, invoice: Invoice) -> None:
    """Drafts have no number yet, so removing one leaves no gap. Issued invoices can only be cancelled."""
    if invoice.status not in {DRAFT, CHECKED} or invoice.number:
        raise InvoiceError(Text("Only drafts can be deleted. Issued invoices stay on record and are cancelled instead.",
                                "Nur Entwürfe können gelöscht werden. Ausgestellte Rechnungen bleiben erhalten und werden storniert."))
    audit.record(session, "owner", "draft_deleted", invoice.id)
    session.delete(invoice)


def days_overdue(invoice: Invoice, on: date) -> int:
    """Days late, based on the earliest unpaid plan payment when a plan is active."""
    plan = invoice.active_plan
    if plan:
        unpaid = [i for i in plan.installments if not i.is_paid]
        if unpaid:
            return (on - unpaid[0].due_date).days
    return (on - invoice.due_date).days if invoice.due_date else 0
