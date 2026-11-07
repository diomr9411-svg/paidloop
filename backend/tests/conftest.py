from datetime import date, timedelta

import pytest
from pydantic import BaseModel
from sqlalchemy.orm import Session

from paidloop import invoices
from paidloop.ai import NoAI
from paidloop.db import Base, make_engine
from paidloop.invoices import LineInput
from paidloop.models import Business, Customer
from paidloop.paypal import SimulatedPayPal


class ScriptedAI:
    """Returns a prepared answer, like a model that says exactly what a test needs."""

    def __init__(self, answer: BaseModel | None = None) -> None:
        self.answer = answer
        self.prompts: list[str] = []

    def ask_json(self, system, user, schema, timeout=None):
        self.prompts.append(user)
        return self.answer

    def status(self):
        return {"available": True, "model": "scripted"}


@pytest.fixture
def db():
    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            Business(
                name="Beispiel Elektro GmbH", street="Musterstraße 1", postcode="32657", city="Lemgo",
                vat_id="DE123456789", email="owner@example.com",
            )
        )
        session.flush()
        yield session


@pytest.fixture
def paypal():
    return SimulatedPayPal()


@pytest.fixture
def no_ai():
    return NoAI()


def add_customer(db, name="Bäckerei Muster GmbH", is_business=True, language="de", **history) -> Customer:
    customer = Customer(name=name, street="Musterweg 2", postcode="32756", city="Detmold",
                        email="kunde@example.com", is_business=is_business, language=language, **history)
    db.add(customer)
    db.flush()
    return customer


LINES = [LineInput("Badreparatur", 4000, "HUR", 6500, 1900), LineInput("Material", 1000, "H87", 12000, 1900)]


def make_issued(db, paypal, customer=None, lines=None, issue_days_ago=0, property_work=False):
    customer = customer or add_customer(db)
    on = invoices.today(db)
    issue_date = on - timedelta(days=issue_days_ago)
    invoice = invoices.save_draft(
        db, None, customer.id, lines or LINES, issue_date, issue_date - timedelta(days=1),
        issue_date + timedelta(days=14), property_work,
    )
    result = invoices.run_check(db, invoice)
    assert result.can_issue, [i.rule_id for i in result.issues]
    invoices.issue(db, invoice, paypal, "http://test")
    db.flush()
    return invoice


def jump(db, days: int) -> None:
    invoices.set_offset(db, invoices.offset_days(db) + days)
    db.flush()


TODAY = date.today()
