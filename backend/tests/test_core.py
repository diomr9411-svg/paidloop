from datetime import date, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from paidloop import audit, ledger, legal
from paidloop.compliance import (
    CONSUMER_NOTICE_DE,
    ERROR,
    RETENTION_NOTE_DE,
    SMALL_BUSINESS_NOTE_DE,
    InvoiceFacts,
    Line,
    Party,
    check,
)
from paidloop.db import Base, make_engine
from paidloop.models import CHECKED, DRAFT, ISSUED, PAID, InvalidTransition, Invoice
from paidloop.money import eur, eur_de, line_net, percent_of, to_cents


@pytest.fixture
def session():
    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db


# Money


@pytest.mark.parametrize("value,cents", [("12.34", 1234), ("0.005", 1), (120, 12000), ("452.20", 45220)])
def test_to_cents(value, cents):
    assert to_cents(value) == cents


def test_percent_and_line_totals():
    assert percent_of(38000, 1900) == 7220
    assert line_net(1500, 6500) == 9750
    assert eur(123450) == "1,234.50 EUR"
    assert eur_de(123450) == "1.234,50 EUR"


# Invoice states


def test_allowed_state_changes():
    invoice = Invoice(status=DRAFT)
    invoice.move_to(CHECKED)
    invoice.move_to(ISSUED)
    invoice.move_to(PAID)
    assert invoice.status == PAID


@pytest.mark.parametrize("start,target", [(DRAFT, ISSUED), (DRAFT, PAID), (PAID, ISSUED), (ISSUED, DRAFT)])
def test_bad_state_changes_are_refused(start, target):
    with pytest.raises(InvalidTransition):
        Invoice(status=start).move_to(target)


# Ledger


def test_entry_must_balance(session):
    with pytest.raises(ledger.UnbalancedEntry):
        ledger.post(session, "x", "bad", date(2026, 1, 1), [(ledger.CASH, 100, 0), (ledger.RECEIVABLE, 0, 99)])


def test_same_key_is_booked_once(session):
    lines = [(ledger.CASH, 100, 0), (ledger.RECEIVABLE, 0, 100)]
    assert ledger.post(session, "pay-1", "first", date(2026, 1, 1), lines) is True
    assert ledger.post(session, "pay-1", "replay", date(2026, 1, 1), lines) is False
    assert ledger.balance(session, ledger.CASH) == 100


def test_debits_equal_credits_after_many_entries(session):
    ledger.post(session, "issue", "invoice", date(2026, 1, 1),
                [(ledger.RECEIVABLE, 45220, 0), (ledger.REVENUE, 0, 38000), (ledger.VAT_PAYABLE, 0, 7220)])
    ledger.post(session, "pay", "payment", date(2026, 1, 2), [(ledger.CASH, 10000, 0), (ledger.RECEIVABLE, 0, 10000)])
    debit, credit = ledger.totals(session)
    assert debit == credit == 55220
    assert ledger.balance(session, ledger.RECEIVABLE) == 35220
    assert ledger.balance(session, ledger.REVENUE) == 38000
    assert ledger.balance(session, ledger.VAT_PAYABLE) == 7220


# Audit trail


def test_audit_chain_is_valid(session):
    audit.record(session, "owner", "created", 1, amount=5)
    audit.record(session, "ai", "proposed", 1, note="Müller")
    assert audit.verify(session) == {"ok": True, "broken_at": None, "checked": 2}


def test_audit_detects_changed_row(session):
    audit.record(session, "owner", "created", 1, amount=5)
    audit.record(session, "ai", "proposed", 1)
    audit.record(session, "owner", "approved", 1)
    session.execute(text("UPDATE audit_event SET data = :data WHERE id = 1"), {"data": '{"amount": 1}'})
    result = audit.verify(session)
    assert result["ok"] is False
    assert result["broken_at"] == 1


def test_audit_detects_deleted_row(session):
    audit.record(session, "owner", "a", 1)
    audit.record(session, "owner", "b", 1)
    audit.record(session, "owner", "c", 1)
    session.execute(text("DELETE FROM audit_event WHERE id = 2"))
    assert audit.verify(session)["broken_at"] == 3


# German late payment law

DUE = date(2026, 3, 1)


def test_b2b_default_starts_30_days_after_due_date():
    assert legal.default_start(DUE, False, False, None) == DUE + timedelta(days=30)


def test_reminder_after_due_date_starts_default_earlier():
    reminder = DUE + timedelta(days=5)
    assert legal.default_start(DUE, False, False, reminder) == reminder


def test_reminder_before_due_date_does_not_count():
    assert legal.default_start(DUE, False, False, DUE - timedelta(days=2)) == DUE + timedelta(days=30)


def test_consumer_needs_notice_for_the_30_day_rule():
    assert legal.default_start(DUE, True, False, None) is None
    assert legal.default_start(DUE, True, True, None) == DUE + timedelta(days=30)


def test_no_costs_before_default():
    costs = legal.late_costs(100000, DUE + timedelta(days=10), DUE, False, False, None)
    assert costs.in_default is False
    assert costs.total_cents == 0


def test_b2b_interest_and_flat_fee():
    today = DUE + timedelta(days=30 + 73)
    costs = legal.late_costs(100000, today, DUE, False, False, None)
    assert costs.rate_percent == legal.BASE_RATE_PERCENT + 9
    assert costs.days == 73
    assert costs.interest_cents == 2104  # 1000 EUR x 10.52% x 73/365
    assert costs.flat_fee_cents == 4000


def test_consumer_interest_has_no_flat_fee():
    today = DUE + timedelta(days=30 + 73)
    costs = legal.late_costs(100000, today, DUE, True, True, None)
    assert costs.rate_percent == legal.BASE_RATE_PERCENT + 5
    assert costs.interest_cents == 1304
    assert costs.flat_fee_cents == 0


# Compliance rules

SELLER = Party("Muster Elektro GmbH", "Beispielstr. 1", "32657", "Lemgo", email="a@example.com")
BUYER = Party("Beispiel GmbH", "Musterweg 2", "32756", "Detmold", email="b@example.com")


def facts(**changes) -> InvoiceFacts:
    base = dict(
        seller=SELLER,
        buyer=BUYER,
        seller_vat_id="DE123456789",
        seller_tax_number="",
        seller_small_business=False,
        buyer_is_business=True,
        issue_date=date(2026, 11, 7),
        service_date=date(2026, 11, 5),
        due_date=date(2026, 11, 21),
        property_work=False,
        lines=(Line("Repair", 4000, 6500, 1900, 26000), Line("Material", 1000, 12000, 1900, 12000)),
        vat_cents=7220,
        gross_cents=45220,
    )
    base.update(changes)
    return InvoiceFacts(**base)


def rule_ids(result, severity=None):
    return {i.rule_id for i in result.issues if severity is None or i.severity == severity}


def test_complete_invoice_can_be_issued():
    result = check(facts())
    assert result.can_issue
    assert rule_ids(result, ERROR) == set()
    assert "R-EINVOICE" in rule_ids(result)


@pytest.mark.parametrize(
    "changes,rule",
    [
        ({"seller": Party("X")}, "R-14-1-SELLER"),
        ({"buyer": Party("", email="b@example.com")}, "R-14-1-BUYER"),
        ({"buyer": Party("Kunde", email="b@example.com")}, "R-14-1-BUYER-ADDRESS"),
        ({"seller_vat_id": ""}, "R-14-2-TAX-ID"),
        ({"issue_date": None}, "R-14-3-DATE"),
        ({"lines": (), "vat_cents": 0, "gross_cents": 0}, "R-14-5-LINES"),
        ({"service_date": None}, "R-14-6-SERVICE-DATE"),
        ({"due_date": None}, "R-DUE"),
        ({"due_date": date(2026, 1, 1)}, "R-DUE-ORDER"),
        ({"vat_cents": 7000, "gross_cents": 45000}, "R-MATH-VAT"),
        ({"gross_cents": 45221}, "R-MATH-TOTAL"),
        ({"buyer": Party("Beispiel GmbH", "Musterweg 2", "32756", "Detmold")}, "R-EMAIL"),
    ],
)
def test_each_required_field_is_enforced(changes, rule):
    result = check(facts(**changes))
    assert rule in rule_ids(result, ERROR)
    assert not result.can_issue


def test_line_math_is_rechecked():
    bad = (Line("Repair", 4000, 6500, 1900, 25000),)
    assert "R-MATH-LINE" in rule_ids(check(facts(lines=bad, vat_cents=4750, gross_cents=29750)), ERROR)


def test_empty_description_and_quantity_and_price():
    bad = (Line(" ", 0, 0, 1900, 0),)
    result = check(facts(lines=bad, vat_cents=0, gross_cents=0))
    assert {"R-14-5-DESC", "R-14-5-QTY", "R-PRICE"} <= rule_ids(result, ERROR)


def test_unsupported_vat_rate():
    lines = (Line("Repair", 1000, 10000, 1600, 10000),)
    assert "R-14-8-RATE" in rule_ids(check(facts(lines=lines, vat_cents=1600, gross_cents=11600)), ERROR)


def test_small_business_must_not_show_vat():
    assert "R-19-NO-VAT" in rule_ids(check(facts(seller_small_business=True)), ERROR)


def test_small_business_without_vat_gets_the_note():
    lines = (Line("Repair", 4000, 6500, 0, 26000),)
    result = check(facts(seller_small_business=True, lines=lines, vat_cents=0, gross_cents=26000))
    assert result.can_issue
    assert SMALL_BUSINESS_NOTE_DE in result.notes_to_print
    assert "R-EINVOICE" not in rule_ids(result)


def test_small_invoice_can_skip_buyer_address_and_tax_id_and_service_date():
    lines = (Line("Repair", 1000, 10000, 1900, 10000),)
    result = check(facts(lines=lines, vat_cents=1900, gross_cents=11900, seller_vat_id="",
                         buyer=Party("Kunde", email="b@example.com"), service_date=None))
    assert result.can_issue
    assert "R-33-BUYER" in rule_ids(result)


def test_250_euro_limit_is_inclusive_and_exact():
    at_limit = (Line("Repair", 1000, 21008, 1900, 21008),)  # 21008 + 3992 VAT = 25000
    over = (Line("Repair", 1000, 21009, 1900, 21009),)  # 21009 + 3992 VAT = 25001
    buyer = Party("Kunde", email="b@example.com")
    assert check(facts(lines=at_limit, vat_cents=3992, gross_cents=25000, buyer=buyer)).can_issue
    result = check(facts(lines=over, vat_cents=3992, gross_cents=25001, buyer=buyer))
    assert "R-14-1-BUYER-ADDRESS" in rule_ids(result, ERROR)


def test_consumer_gets_30_day_notice():
    result = check(facts(buyer_is_business=False))
    assert CONSUMER_NOTICE_DE in result.notes_to_print
    assert RETENTION_NOTE_DE not in result.notes_to_print


def test_private_customer_with_property_work_gets_retention_note():
    result = check(facts(buyer_is_business=False, property_work=True))
    assert RETENTION_NOTE_DE in result.notes_to_print
    assert "R-14-9-RETENTION" in rule_ids(result)


def test_business_customer_needs_no_retention_note():
    assert RETENTION_NOTE_DE not in check(facts(property_work=True)).notes_to_print


def test_every_issue_has_a_law_reference_and_a_fix():
    result = check(InvoiceFacts(Party(), Party(), "", "", False, True, None, None, None, False, (), 0, 0))
    assert result.issues
    for issue in result.issues:
        assert issue.law and issue.message and issue.fix
