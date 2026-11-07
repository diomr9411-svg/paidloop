"""Made-up demo data with one-click reset. All names, addresses and tax IDs here are fictional."""

from __future__ import annotations

import secrets
from datetime import date, timedelta

from sqlalchemy.orm import Session

from paidloop import invoices
from paidloop.db import Base
from paidloop.invoices import LineInput
from paidloop.models import Business, Customer

EXAMPLE_EMAIL = "customer@example.com"


def _customer(session: Session, email: str, **fields) -> Customer:
    customer = Customer(email=email, **fields)
    session.add(customer)
    session.flush()
    return customer


def _issue(session: Session, paypal, customer: Customer, lines: list[LineInput], issued_days_ago: int,
           payment_days: int, property_work: bool, public_base: str):
    on = date.today() - timedelta(days=issued_days_ago)
    draft = invoices.save_draft(
        session, None, customer.id, lines, on, on - timedelta(days=2), on + timedelta(days=payment_days), property_work,
    )
    result = invoices.run_check(session, draft)
    if not result.can_issue:
        raise invoices.InvoiceError(f"Demo invoice failed the check: {[i.rule_id for i in result.issues]}")
    return invoices.issue(session, draft, paypal, public_base)


def reset(session: Session, paypal, buyer_email: str, public_base: str) -> None:
    """Clear everything and create the demo story. PayPal keeps old sandbox invoices, so numbers get a new suffix."""
    session.rollback()
    engine = session.get_bind()
    session.close()
    Base.metadata.drop_all(engine)  # also picks up new columns after an update
    Base.metadata.create_all(engine)

    session.add(
        Business(
            name="Beispiel Elektro GmbH",
            street="Musterstraße 1",
            postcode="32657",
            city="Lemgo",
            country="DE",
            vat_id="DE000000000",
            email="owner@example.com",
            small_business=False,
            vat_method="soll",
            paypal_suffix=secrets.token_hex(3).upper(),
        )
    )
    session.flush()

    email = buyer_email or EXAMPLE_EMAIL
    bakery = _customer(session, email, name="Bäckerei Muster GmbH", street="Musterweg 2", postcode="32756", city="Detmold",
                       is_business=True, language="de", history_paid_count=9, history_avg_days_late=1)
    cafe = _customer(session, email, name="Café Beispiel UG", street="Beispielplatz 5", postcode="32052", city="Herford",
                     is_business=True, language="de", history_paid_count=6, history_avg_days_late=18, history_unpaid_count=1)
    private = _customer(session, email, name="Anna Beispiel", street="Testallee 7", postcode="32760", city="Detmold",
                        is_business=False, language="de")
    studio = _customer(session, email, name="Sample Studio Ltd", street="Example Road 3", postcode="33602", city="Bielefeld",
                       is_business=True, language="en", history_paid_count=4, history_avg_days_late=2)

    paid = _issue(session, paypal, studio,
                  [LineInput("Office wiring check", 3000, "HUR", 7000, 1900)], 25, 14, False, public_base)
    paypal.record_payment(paid.paypal_id, paid.gross_cents, date.today() - timedelta(days=9), "Demo payment")
    invoices.sync(session, paid, paypal)

    _issue(session, paypal, bakery,
           [LineInput("Oven connection repair", 2500, "HUR", 7000, 1900), LineInput("Material", 1000, "H87", 8990, 1900)],
           5, 14, True, public_base)
    _issue(session, paypal, cafe,
           [LineInput("Kitchen lights replaced", 6000, "HUR", 6500, 1900), LineInput("LED panels", 4000, "H87", 8900, 1900)],
           20, 14, True, public_base)
    _issue(session, paypal, private,
           [LineInput("Bathroom wiring repair", 4000, "HUR", 6500, 1900), LineInput("Material", 1000, "H87", 12000, 1900)],
           16, 14, True, public_base)
    session.flush()
