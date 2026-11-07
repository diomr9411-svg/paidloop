"""Measures the main screens with many invoices, with and without the indexes. Uses a temporary database.

Run:  python scripts/benchmark_indexes.py [number of invoices]
"""

import os
import random
import statistics
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import insert, text  # noqa: E402

from paidloop.ai import NoAI  # noqa: E402
from paidloop.db import Base  # noqa: E402
from paidloop.main import create_app  # noqa: E402
from paidloop.models import AuditEvent, Customer, Installment, Invoice, PaymentPlan, Proposal  # noqa: E402
from paidloop.paypal import SimulatedPayPal  # noqa: E402
from paidloop.settings import Settings  # noqa: E402

COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
CUSTOMERS = max(COUNT // 20, 10)
TODAY = date(2026, 11, 7)
# A firm with many old invoices: nearly all are closed, about 2 in 100 are still open.
STATUSES = ["paid"] * 965 + ["cancelled"] * 13 + ["issued"] * 15 + ["on_plan"] * 3 + ["disputed"] * 2 + ["draft"] * 2
ROUTES = {
    "Home screen": "/api/dashboard",
    "Invoice list, newest": "/api/invoices",
    "Invoice list, page 200": "/api/invoices?page=200",
    "Filter: overdue": "/api/invoices?filter=overdue",
    "Filter: paid, sorted by amount": "/api/invoices?filter=paid&sort=amount",
    "All, sorted by due date": "/api/invoices?sort=due",
    "All, sorted by customer": "/api/invoices?sort=customer",
    "Search by customer": "/api/invoices?q=kunde%20123",
    "Search by number": "/api/invoices?q=RE-2026-0012345",
    "Approvals": "/api/approvals",
    "Audit list": "/api/audit?limit=50",
}


def fill(sessions) -> None:
    """Straight inserts with the real table definitions, so all defaults apply."""
    rng = random.Random(7)
    with sessions() as session:
        session.execute(insert(Customer), [
            {"id": i, "name": f"Kunde {i} GmbH", "name_key": f"kunde {i} gmbh", "street": "Weg 1", "postcode": "32756",
             "city": "Detmold", "email": f"k{i}@example.com"} for i in range(1, CUSTOMERS + 1)])
        invoices, plans, installments, proposals, events = [], [], [], [], []
        for i in range(1, COUNT + 1):
            status = rng.choice(STATUSES)
            due = TODAY - timedelta(days=rng.randint(-30, 700))
            gross = rng.randint(5000, 500000)
            invoices.append({
                "id": i, "customer_id": rng.randint(1, CUSTOMERS), "number": None if status == "draft" else f"RE-2026-{i:07d}",
                "status": status, "issue_date": due - timedelta(days=14), "due_date": due, "service_date": due - timedelta(days=15),
                "gross_cents": gross, "net_cents": gross - gross // 6, "vat_cents": gross // 6, "paid_cents": gross if status == "paid" else 0,
                "paid_on": due + timedelta(days=rng.randint(-5, 30)) if status == "paid" else None, "public_token": f"tok{i:030d}",
            })
            if status == "on_plan":
                plans.append({"id": i, "invoice_id": i, "status": "active", "created_by": "agent"})
                installments.append({"plan_id": i, "seq": 1, "amount_cents": gross // 2, "due_date": due})
                installments.append({"plan_id": i, "seq": 2, "amount_cents": gross - gross // 2, "due_date": due + timedelta(days=30)})
            if status == "issued" and i % 5 == 0:
                proposals.append({"invoice_id": i, "action": "firm_reminder", "reason": "late", "reason_de": "spät", "subject": "s", "body": "b", "payload": "{}"})
            events.append({"id": i, "at": "2026-11-07T10:00:00+00:00", "actor": "rules", "action": "checked", "invoice_id": i, "data": "{}",
                           "prev_hash": "0" * 64, "hash": f"{i:064d}"})
        session.execute(insert(Invoice), invoices)
        if plans:
            session.execute(insert(PaymentPlan), plans)
            session.execute(insert(Installment), installments)
        if proposals:
            session.execute(insert(Proposal), proposals)
        session.execute(insert(AuditEvent), events)
        session.commit()


def measure(client: TestClient) -> dict[str, float]:
    results = {}
    for label, route in ROUTES.items():
        times = []
        for _ in range(5):
            started = time.perf_counter()
            response = client.get(route)
            times.append((time.perf_counter() - started) * 1000)
            assert response.status_code == 200, (route, response.text[:200])
        results[label] = statistics.median(times)
    return results


def main() -> None:
    folder = tempfile.mkdtemp(prefix="paidloop-bench-")
    settings = Settings(_env_file=None, database_url=f"sqlite:///{folder}/bench.db", paypal_client_id="", ollama_model="", sync_interval_seconds=0)
    app = create_app(settings, SimulatedPayPal(Path(folder) / "paypal.json"), NoAI())
    with TestClient(app) as client:
        print(f"Filling {COUNT} invoices for {CUSTOMERS} customers...")
        fill(app.state.sessions)
        with app.state.sessions() as session:
            session.execute(text("ANALYZE"))
            session.commit()
            engine = session.get_bind()
        with_indexes = measure(client)

        names = [index.name for table in Base.metadata.sorted_tables for index in table.indexes]
        with engine.begin() as connection:
            for name in names:
                connection.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
            connection.execute(text("ANALYZE"))
        without = measure(client)

    print(f"\nMedian of 5 requests, {COUNT} invoices, this laptop. Times in milliseconds.\n")
    print(f"| {'Screen':32} | {'With indexes':>12} | {'Without':>9} |")
    print(f"|{'-' * 34}|{'-' * 14}|{'-' * 11}|")
    for label in ROUTES:
        print(f"| {label:32} | {with_indexes[label]:12.1f} | {without[label]:9.1f} |")


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    main()
