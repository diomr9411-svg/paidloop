"""Stored data must be found through indexes, and screens must not run one query per row."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, text

from paidloop.db import Base, make_engine, prepare
from paidloop.main import create_app
from paidloop.models import Customer, Installment, Invoice, PaymentPlan, Proposal
from paidloop.paypal import SimulatedPayPal
from paidloop.settings import Settings
from paidloop.ai import NoAI


def plan_of(connection, sql: str, **params) -> str:
    rows = connection.execute(text(f"EXPLAIN QUERY PLAN {sql}"), params).all()
    return " | ".join(str(row[-1]) for row in rows)


@pytest.fixture
def engine(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'index.db'}")
    prepare(engine)
    return engine


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        ("SELECT id FROM invoice WHERE status = 'issued' ORDER BY id DESC LIMIT 25", "ix_invoice_status_id"),
        ("SELECT id FROM invoice WHERE status = 'issued' AND due_date < '2026-01-01'", "ix_invoice_status_due"),
        ("SELECT id FROM invoice ORDER BY due_date DESC LIMIT 25", "ix_invoice_due"),
        ("SELECT id FROM invoice ORDER BY gross_cents DESC LIMIT 25", "ix_invoice_gross"),
        ("SELECT status, count(id) FROM invoice GROUP BY status", "ix_invoice_status"),
        ("SELECT id FROM invoice WHERE customer_id = 1 ORDER BY id DESC", "ix_invoice_customer"),
        ("SELECT id FROM invoice WHERE paypal_id = 'x'", "ix_invoice_paypal_id"),
        ("SELECT id FROM invoice WHERE public_token = 'x'", "sqlite_autoindex_invoice"),
        ("SELECT id FROM invoice_line WHERE invoice_id = 1 ORDER BY position", "ix_invoice_line_invoice"),
        ("SELECT id FROM payment WHERE invoice_id = 1", "ix_payment_invoice"),
        ("SELECT id FROM payment_plan WHERE invoice_id = 1 AND status = 'active'", "ix_plan_invoice_status"),
        ("SELECT id FROM installment WHERE plan_id = 1 ORDER BY seq", "ix_installment_plan"),
        ("SELECT id FROM installment WHERE paypal_id = 'x'", "ix_installment_paypal_id"),
        ("SELECT id FROM proposal WHERE status = 'pending' ORDER BY id", "ix_proposal_status_id"),
        ("SELECT id FROM proposal WHERE invoice_id = 1 AND status = 'pending'", "ix_proposal_invoice_status"),
        ("SELECT count(id) FROM chat_message WHERE invoice_id = 1 AND role = 'customer' AND created_at >= '2026-01-01'", "ix_chat_invoice_role_time"),
        ("SELECT id FROM chat_message WHERE invoice_id = 1 ORDER BY id", "ix_chat_invoice_id"),
        ("SELECT id FROM journal_entry WHERE invoice_id = 1", "ix_journal_entry_invoice"),
        ("SELECT id FROM journal_line WHERE entry_id = 1", "ix_journal_line_entry"),
        ("SELECT sum(debit_cents), sum(credit_cents) FROM journal_line WHERE account = 'cash'", "ix_journal_line_account"),
        ("SELECT id FROM audit_event WHERE invoice_id = 1 AND id < 100 ORDER BY id DESC LIMIT 50", "ix_audit_invoice_id"),
        ("SELECT id FROM customer WHERE name_key = 'x'", "ix_customer_name_key"),
        ("SELECT id FROM customer ORDER BY name_key LIMIT 50", "ix_customer_name_key"),
    ],
)
def test_query_uses_its_index(engine, sql, expected):
    with engine.connect() as connection:
        plan = plan_of(connection, sql)
    assert expected in plan, plan


def test_results_on_home_are_read_from_the_index_alone(engine):
    sql = ("SELECT count(id), avg(julianday(paid_on) - julianday(issue_date)), sum(CASE WHEN paid_on <= due_date THEN 1 ELSE 0 END) "
           "FROM invoice WHERE status = 'paid'")
    with engine.connect() as connection:
        plan = plan_of(connection, sql)
        timed = plan_of(connection, "SELECT avg(seconds_to_issue), count(seconds_to_issue) FROM invoice WHERE seconds_to_issue IS NOT NULL")
    assert "COVERING INDEX ix_invoice_paid_results" in plan, plan
    assert "COVERING INDEX ix_invoice_timed" in timed, timed


def test_balances_are_read_from_the_index_alone(engine):
    with engine.connect() as connection:
        plan = plan_of(connection, "SELECT sum(debit_cents), sum(credit_cents) FROM journal_line WHERE account = 'cash'")
    assert "COVERING INDEX" in plan, plan


def test_an_old_database_gets_new_columns_indexes_and_search_keys(tmp_path):
    path = tmp_path / "old.db"
    engine = make_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO customer (name, name_key, street, postcode, city, country, email, is_business, language, "
                                "history_paid_count, history_avg_days_late, history_unpaid_count) "
                                "VALUES ('Alt  GmbH', '', '', '', '', 'DE', '', 1, 'de', 0, 0, 0)"))
        connection.execute(text("DROP INDEX ix_invoice_status_id"))
        connection.execute(text("DROP INDEX ix_customer_name_key"))
        connection.execute(text("DROP INDEX ix_invoice_timed"))
        connection.execute(text("ALTER TABLE invoice DROP COLUMN seconds_to_issue"))
        connection.execute(text("ALTER TABLE proposal DROP COLUMN reason_de"))

    prepare(engine)

    check = inspect(make_engine(f"sqlite:///{path}"))
    assert "seconds_to_issue" in {column["name"] for column in check.get_columns("invoice")}
    assert "reason_de" in {column["name"] for column in check.get_columns("proposal")}
    assert {"ix_invoice_status_id", "ix_invoice_timed"} <= {index["name"] for index in check.get_indexes("invoice")}
    assert "ix_customer_name_key" in {index["name"] for index in check.get_indexes("customer")}
    with engine.connect() as connection:
        assert connection.execute(text("SELECT name_key FROM customer")).scalar() == "alt gmbh"

    prepare(engine)  # running it again must change nothing and must not fail


# Real requests, counting the SQL they run


@pytest.fixture
def client(tmp_path):
    settings = Settings(_env_file=None, database_url=f"sqlite:///{tmp_path / 'api.db'}", paypal_client_id="", ollama_model="",
                        sync_interval_seconds=0)
    app = create_app(settings, SimulatedPayPal(tmp_path / "paypal.json"), NoAI())
    with TestClient(app) as test_client:
        test_client.app = app
        yield test_client


def fill(app, count: int) -> None:
    """Many invoices with customers, plans and pending steps, written straight to the database."""
    today = date(2026, 11, 7)
    with app.state.sessions() as session:
        customers = [Customer(name=f"Kunde {i} GmbH", email=f"k{i}@example.com") for i in range(count)]
        session.add_all(customers)
        session.flush()
        for i in range(count):
            status = ["issued", "on_plan", "disputed", "paid", "draft"][i % 5]
            invoice = Invoice(
                customer=customers[i], status=status, number=None if status == "draft" else f"RE-2026-{i:05d}",
                issue_date=today, due_date=today - timedelta(days=(i % 40) - 10), gross_cents=10000 + i, net_cents=8403,
                vat_cents=1597 + i, paid_cents=0, public_token=f"token-{i:030d}",
            )
            session.add(invoice)
            if status == "on_plan":
                plan = PaymentPlan(invoice=invoice, status="active", created_by="agent")
                plan.installments = [
                    Installment(seq=1, amount_cents=5000, due_date=today - timedelta(days=5)),
                    Installment(seq=2, amount_cents=5000 + i, due_date=today + timedelta(days=25)),
                ]
                session.add(plan)
            if status == "issued":
                session.add(Proposal(invoice=invoice, action="firm_reminder", reason="x", reason_de="y", subject="s", body="b", payload="{}"))
        session.commit()


def count_queries(app, call) -> int:
    seen: list[str] = []

    def before(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    with app.state.sessions() as session:
        engine = session.get_bind()
    event.listen(engine, "before_cursor_execute", before)
    try:
        response = call()
        assert response.status_code == 200, response.text
    finally:
        event.remove(engine, "before_cursor_execute", before)
    return len(seen)


@pytest.mark.parametrize("path", ["/api/invoices?size=100", "/api/invoices?filter=overdue&size=100", "/api/dashboard", "/api/approvals"])
def test_screens_do_not_run_one_query_per_row(client, path):
    fill(client.app, 20)
    small = count_queries(client.app, lambda: client.get(path))
    fill_more = 80
    with client.app.state.sessions() as session:
        session.execute(text("DELETE FROM installment"))
        session.execute(text("DELETE FROM payment_plan"))
        session.execute(text("DELETE FROM proposal"))
        session.execute(text("DELETE FROM invoice"))
        session.execute(text("DELETE FROM customer"))
        session.commit()
    fill(client.app, fill_more + 20)
    large = count_queries(client.app, lambda: client.get(path))
    assert large == small, f"{small} queries for 20 rows, {large} queries for 100 rows"


def test_invoice_list_pages_filters_and_counts(client):
    fill(client.app, 60)
    first = client.get("/api/invoices?size=25").json()
    assert first["total"] == 60 and len(first["items"]) == 25
    second = client.get("/api/invoices?size=25&page=2").json()
    assert not {row["id"] for row in first["items"]} & {row["id"] for row in second["items"]}
    assert first["counts"] == {"all": 60, "open": 36, "overdue": first["counts"]["overdue"], "on_plan": 12, "disputed": 12,
                               "draft": 12, "paid": 12, "cancelled": 0}

    for name in ("open", "on_plan", "disputed", "draft", "paid", "cancelled"):
        body = client.get(f"/api/invoices?filter={name}&size=100").json()
        assert body["total"] == first["counts"][name], name

    overdue = client.get("/api/invoices?filter=overdue&size=100").json()
    assert overdue["total"] == first["counts"]["overdue"] > 0
    assert all(row["days_overdue"] > 0 for row in overdue["items"])

    # An unknown filter shows everything instead of failing.
    assert client.get("/api/invoices?filter=nonsense").json()["total"] == 60


def test_invoice_search_finds_number_and_customer_and_treats_wildcards_as_text(client):
    fill(client.app, 30)
    assert client.get("/api/invoices?q=00011").json()["total"] == 1
    by_name = client.get("/api/invoices", params={"q": "kunde 7 gmbh"}).json()
    assert by_name["total"] == 1 and by_name["items"][0]["customer"]["name"] == "Kunde 7 GmbH"
    assert client.get("/api/invoices", params={"q": "%"}).json()["total"] == 0
    assert client.get("/api/invoices", params={"q": "_"}).json()["total"] == 0


@pytest.mark.parametrize(("sort", "key"), [("amount", lambda row: row["gross_cents"]), ("due", lambda row: row["due_date"]),
                                            ("customer", lambda row: row["customer"]["name"].casefold())])
def test_invoice_sorting_works_both_ways(client, sort, key):
    fill(client.app, 25)
    up = client.get(f"/api/invoices?sort={sort}&dir=asc&size=100").json()["items"]
    down = client.get(f"/api/invoices?sort={sort}&dir=desc&size=100").json()["items"]
    assert [key(row) for row in up] == sorted(key(row) for row in up)
    assert [key(row) for row in down] == sorted((key(row) for row in down), reverse=True)


def test_lists_refuse_impossible_requests_with_a_clear_message(client):
    response = client.get("/api/invoices?size=100000", headers={"X-Language": "de"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Bitte prüfen Sie Ihre Eingaben."
    assert client.get("/api/invoices?sort=drop_table").status_code == 422


def test_audit_list_continues_from_the_last_row_and_verifies_separately(client):
    client.post("/api/demo/reset")
    first = client.get("/api/audit?limit=5").json()
    assert len(first["events"]) == 5 and first["next_before_id"] == first["events"][-1]["id"]
    second = client.get(f"/api/audit?limit=5&before_id={first['next_before_id']}").json()
    assert second["events"][0]["id"] < first["events"][-1]["id"]
    assert "chain" not in first
    assert client.get("/api/audit/verify").json()["ok"] is True


def test_list_does_not_read_stored_pdfs(client):
    """Lists stay light even if every invoice has a large file."""
    fill(client.app, 5)
    with client.app.state.sessions() as session:
        session.execute(text("UPDATE invoice SET pdf = zeroblob(5000000)"))
        session.commit()
    seen: list[str] = []

    def before(_connection, _cursor, statement, _parameters, _context, _many):
        seen.append(statement)

    with client.app.state.sessions() as session:
        engine = session.get_bind()
    event.listen(engine, "before_cursor_execute", before)
    try:
        assert client.get("/api/invoices").status_code == 200
        assert client.get("/api/dashboard").status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", before)
    assert not [statement for statement in seen if "invoice.pdf" in statement]


def test_same_customer_typed_twice_is_one_customer(client):
    one = client.post("/api/customers", json={"name": "Bäckerei  Muster GmbH", "email": "a@example.com"}).json()
    two = client.post("/api/customers", json={"name": "bäckerei muster gmbh", "city": "Detmold", "email": "A@example.com"}).json()
    assert one["id"] == two["id"]
    assert two["city"] == "Detmold"
    # The same name with a different email can be a different firm, so it stays separate.
    other = client.post("/api/customers", json={"name": "Bäckerei Muster GmbH", "email": "b@example.com"}).json()
    assert other["id"] != one["id"]
    assert len(client.get("/api/customers", params={"q": "muster"}).json()) == 2
    assert client.get("/api/customers", params={"q": "%"}).json() == []


def test_a_draft_can_be_deleted_but_an_issued_invoice_cannot(client):
    client.post("/api/demo/reset")
    customer = client.post("/api/customers", json={"name": "Weg GmbH", "street": "Weg 1", "postcode": "32756", "city": "Detmold",
                                                   "email": "w@example.com"}).json()
    draft = client.post("/api/invoices", json={"customer_id": customer["id"], "service_date": "2026-11-01", "due_date": "2026-11-20", "lines": [
        {"description": "Arbeit", "quantity": 1, "unit": "H87", "unit_price_eur": 100, "vat_percent": 19}]}).json()
    assert client.post(f"/api/invoices/{draft['id']}/check").json()["can_issue"] is True
    keep = client.post(f"/api/invoices/{draft['id']}/issue", json={"seconds_to_issue": 42}).json()
    refused = client.delete(f"/api/invoices/{keep['id']}", headers={"X-Language": "de"})
    assert refused.status_code == 422 and "Entwürfe" in refused.json()["detail"]
    assert client.get("/api/dashboard").json()["performance"]["avg_seconds_to_issue"] == 42

    second = client.post("/api/invoices", json={"customer_id": customer["id"], "lines": [
        {"description": "Arbeit", "quantity": 1, "unit": "H87", "unit_price_eur": 100, "vat_percent": 19}]}).json()
    assert client.delete(f"/api/invoices/{second['id']}").json()["status"] == "deleted"
    assert client.get(f"/api/invoices/{second['id']}").status_code == 404
    assert client.get("/api/audit/verify").json()["ok"] is True


def test_home_shows_measured_results_and_a_work_queue(client):
    client.post("/api/demo/reset")
    client.post("/api/demo/jump", json={"days": 16})
    view = client.get("/api/dashboard").json()
    assert sum(view["aging"].values()) == view["open_cents"]
    assert view["performance"]["paid_count"] >= 1
    kinds = {item["kind"] for item in view["queue"]}
    assert "no_reminder_yet" in kinds
    assert all(set(item) >= {"kind", "invoice_id", "amount_cents", "customer"} for item in view["queue"])
    client.post("/api/agent/run")
    client.post("/api/demo/jump", json={"days": 8})
    client.post("/api/agent/run")
    view = client.get("/api/dashboard").json()
    approvals = [item for item in view["queue"] if item["kind"] == "approval"]
    assert approvals and view["queue"][0]["kind"] == "approval"
    assert client.get("/api/health").json()["pending_approvals"] == len(approvals)
