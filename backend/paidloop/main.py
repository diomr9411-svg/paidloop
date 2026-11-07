"""PaidLoop API. It runs on your own computer, and only /api/pay/... is meant for customers."""

from __future__ import annotations

import json
import logging
import threading
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session, selectinload

from paidloop import audit, capture, compliance, dashboard, demo, followup, invoices, ledger, legal, negotiation
from paidloop.ai import AI, LocalAI, NoAI
from paidloop.db import make_engine, make_session_factory, prepare
from paidloop.i18n import LocalizedError, Text, language_from_header, pick
from paidloop.invoices import LineInput
from paidloop.models import (
    AuditEvent,
    Business,
    Customer,
    InvalidTransition,
    Invoice,
    Installment,
    PaymentPlan,
    Proposal,
    WebhookEvent,
    name_key,
)
from paidloop.money import to_cents
from paidloop.negotiation import ChatRefused
from paidloop.paypal import PayPalClient, PayPalError, SimulatedPayPal
from paidloop.settings import REPO_ROOT, Settings, get_settings

log = logging.getLogger("paidloop")
FRONTEND = REPO_ROOT / "frontend" / "dist"


# Request bodies


class BusinessIn(BaseModel):
    name: str = Field(max_length=200)
    street: str = Field(default="", max_length=200)
    postcode: str = Field(default="", max_length=20)
    city: str = Field(default="", max_length=100)
    vat_id: str = Field(default="", max_length=30)
    tax_number: str = Field(default="", max_length=30)
    email: str = Field(default="", max_length=200)
    small_business: bool = False
    vat_method: str = Field(default="soll", pattern="^(soll|ist)$")
    max_installments: int = Field(default=4, ge=2, le=12)
    min_first_payment_pct: int = Field(default=20, ge=0, le=90)
    max_plan_days: int = Field(default=90, ge=30, le=365)
    min_installment_eur: float = Field(default=20, ge=1, le=100000)
    reminder_gap_days: int = Field(default=7, ge=1, le=60)
    payment_days: int = Field(default=14, ge=0, le=90)


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    street: str = Field(default="", max_length=200)
    postcode: str = Field(default="", max_length=20)
    city: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    is_business: bool = True
    language: str = Field(default="de", pattern="^(de|en)$")


class LineIn(BaseModel):
    description: str = Field(default="", max_length=300)
    quantity: float = Field(ge=0, le=100000)
    unit: str = Field(default="H87", pattern="^(HUR|H87)$")
    unit_price_eur: float = Field(ge=0, le=10000000)
    vat_percent: float = Field(default=19, ge=0, le=100)


class DraftIn(BaseModel):
    customer_id: int | None = None
    lines: list[LineIn] = Field(max_length=100)
    issue_date: date | None = None
    service_date: date | None = None
    due_date: date | None = None
    property_work: bool = False
    source_text: str = Field(default="", max_length=capture.MAX_TEXT_CHARS)
    capture_source: str = Field(default="manual", pattern="^(ai|rules|manual)$")


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=capture.MAX_TEXT_CHARS)


class ChatIn(BaseModel):
    text: str = Field(max_length=5000)


class ApproveIn(BaseModel):
    body: str | None = Field(default=None, max_length=4000)


class JumpIn(BaseModel):
    days: int = Field(ge=-365, le=365)


class PaymentIn(BaseModel):
    amount_eur: float = Field(gt=0, le=10000000)
    paid_on: date | None = None


class CancelIn(BaseModel):
    reason: str = Field(default="", max_length=200)


class IssueIn(BaseModel):
    seconds_to_issue: int | None = Field(default=None, ge=0, le=7 * 24 * 3600)


LIST_FILTERS = {"all", "open", "overdue", "on_plan", "disputed", "draft", "paid", "cancelled"}
NOT_FOUND = Text("Not found.", "Nicht gefunden.")


# Turning records into JSON


def line_json(line) -> dict:
    return {
        "description": line.description,
        "quantity": line.quantity_milli / 1000,
        "unit": line.unit,
        "unit_price_cents": line.unit_price_cents,
        "vat_percent": line.vat_bp / 100,
        "net_cents": line.net_cents,
    }


def customer_json(customer: Customer | None) -> dict | None:
    if customer is None:
        return None
    return {
        "id": customer.id,
        "name": customer.name,
        "street": customer.street,
        "postcode": customer.postcode,
        "city": customer.city,
        "email": customer.email,
        "is_business": customer.is_business,
        "language": customer.language,
    }


def plan_json(plan) -> dict | None:
    if plan is None:
        return None
    return {
        "id": plan.id,
        "status": plan.status,
        "created_by": plan.created_by,
        "installments": [
            {
                "seq": i.seq,
                "amount_cents": i.amount_cents,
                "paid_cents": i.paid_cents,
                "due_date": i.due_date,
                "pay_link": i.pay_link,
                "is_paid": i.is_paid,
            }
            for i in plan.installments
        ],
    }


def invoice_summary(session: Session, invoice: Invoice, on: date, pending_ids: set[int] | None = None) -> dict:
    return {
        "id": invoice.id,
        "number": invoice.number,
        "status": invoice.status,
        "customer": customer_json(invoice.customer),
        "issue_date": invoice.issue_date,
        "due_date": invoice.due_date,
        "gross_cents": invoice.gross_cents,
        "paid_cents": invoice.paid_cents,
        "open_cents": invoice.open_cents,
        "days_overdue": invoices.days_overdue(invoice, on) if invoice.due_date else 0,
        "reminder_level": invoice.reminder_level,
        "paused_until": invoice.paused_until,
        "has_pending": invoice.id in pending_ids if pending_ids is not None else any(p.status == "pending" for p in invoice.proposals),
    }


def invoice_detail(session: Session, invoice: Invoice, language: str = "en") -> dict:
    on = invoices.today(session)
    data = invoice_summary(session, invoice, on)
    data.update(
        service_date=invoice.service_date,
        property_work=invoice.property_work,
        source_text=invoice.source_text,
        capture_source=invoice.capture_source,
        net_cents=invoice.net_cents,
        vat_cents=invoice.vat_cents,
        lines=[line_json(line) for line in invoice.lines],
        pay_link=invoice.pay_link,
        credit_note_number=invoice.credit_note_number,
        public_token=invoice.public_token,
        default_since=invoice.default_since,
        last_reminder_on=invoice.last_reminder_on,
        payments=[{"amount_cents": p.amount_cents, "paid_on": p.paid_on, "method": p.method} for p in invoice.payments],
        plan=plan_json(invoice.active_plan),
        offer=plan_json(invoice.open_offer),
        messages=[{"role": m.role, "text": m.text, "intent": m.intent, "at": m.created_at} for m in invoice.messages],
    )
    if invoice.number and invoice.customer:
        assessed = followup.risk_of(session, invoice, on)
        data["risk"] = {"score": assessed.score, "level": assessed.level, "reasons": [pick(reason, language) for reason in assessed.reasons],
                        "expected_days_late": assessed.expected_days_late}
        costs = followup.late_costs_of(invoice, on)
        data["late_costs"] = {
            "in_default": costs.in_default,
            "default_since": costs.default_since,
            "rate_percent": str(costs.rate_percent),
            "interest_cents": costs.interest_cents,
            "flat_fee_cents": costs.flat_fee_cents,
            "base_rate_percent": str(legal.BASE_RATE_PERCENT),
        }
    return data


def proposal_json(session: Session, proposal: Proposal, on: date, language: str = "en") -> dict:
    payload = json.loads(proposal.payload or "{}")
    return {
        "id": proposal.id,
        "action": proposal.action,
        "reason": (proposal.reason_de or proposal.reason) if language == "de" else proposal.reason,
        "decided_by_ai": proposal.decided_by_ai,
        "subject": proposal.subject,
        "body": proposal.body,
        "english": payload.get("english", ""),
        "german": payload.get("german", ""),
        "status": proposal.status,
        "created_at": proposal.created_at,
        "invoice": invoice_summary(session, proposal.invoice, on),
    }


def check_json(result, language: str = "en") -> dict:
    return {
        "can_issue": result.can_issue,
        "issues": [
            {
                "rule_id": issue.rule_id,
                "severity": issue.severity,
                "field": issue.field,
                "law": compliance.law_in_german(issue.law) if language == "de" else issue.law,
                "message": pick(issue.message, language),
                "fix": pick(issue.fix, language),
            }
            for issue in result.issues
        ],
        "notes_to_print": result.notes_to_print,
    }


def find_customer(session: Session, name: str) -> Customer | None:
    """Same name first, using the index. Then a customer whose name has every word."""
    key = name_key(name)
    if not key:
        return None
    exact = session.scalar(select(Customer).where(Customer.name_key == key).order_by(Customer.id).limit(1))
    if exact:
        return exact
    query = select(Customer).order_by(Customer.name_key).limit(1)
    for word in key.split():
        query = query.where(Customer.name_key.contains(word, autoescape=True))
    return session.scalar(query)


def capture_json(session: Session, result: capture.CaptureResult) -> dict:
    extracted = result.extracted
    found = find_customer(session, extracted.customer_name) if extracted.customer_name else None
    known = customer_json(found)
    business = invoices.business_of(session)
    return {
        "source": result.source,
        "source_text": result.source_text,
        "extracted": extracted.model_dump(),
        "unsure": result.unsure,
        # Both languages, because reading a note again would run the AI again.
        "warnings": [{"en": str(warning), "de": pick(warning, "de")} for warning in result.warnings],
        "property_work": result.property_work,
        "known_customer": known,
        "today": invoices.today(session),
        "payment_days": business.payment_days,
        "default_vat_percent": 0 if business.small_business else 19,
    }


def business_json(business: Business) -> dict:
    return {
        "name": business.name,
        "street": business.street,
        "postcode": business.postcode,
        "city": business.city,
        "vat_id": business.vat_id,
        "tax_number": business.tax_number,
        "email": business.email,
        "small_business": business.small_business,
        "vat_method": business.vat_method,
        "max_installments": business.max_installments,
        "min_first_payment_pct": business.min_first_payment_pct,
        "max_plan_days": business.max_plan_days,
        "min_installment_eur": business.min_installment_cents / 100,
        "reminder_gap_days": business.reminder_gap_days,
        "payment_days": business.payment_days,
    }


def build_paypal(settings: Settings):
    if settings.has_paypal_keys:
        return PayPalClient(settings.paypal_base_url, settings.paypal_client_id, settings.paypal_client_secret.get_secret_value())
    return SimulatedPayPal(REPO_ROOT / "data" / "simulated_paypal.json")


def build_ai(settings: Settings) -> AI:
    if not settings.ollama_model:
        return NoAI()
    return LocalAI(settings.ollama_base_url, settings.ollama_model, settings.ai_timeout_seconds,
                   REPO_ROOT / "data" / "ai_answers.json", cpu_only=settings.ai_cpu_only)


def language_of(request: Request) -> str:
    return language_from_header(request.headers.get("x-language") or request.headers.get("accept-language"))


def create_app(settings: Settings | None = None, paypal=None, ai: AI | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    prepare(engine)
    sessions = make_session_factory(engine)
    paypal = paypal if paypal is not None else build_paypal(settings)
    ai = ai if ai is not None else build_ai(settings)
    public_base = settings.public_base_url.rstrip("/")
    stop_sync = threading.Event()
    sync_state: dict[str, str | None] = {"last_ok_at": None, "last_error": None}

    def now_text() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def sync_loop() -> None:
        """Payment updates work without a public webhook address, because the app asks PayPal itself."""
        while not stop_sync.wait(settings.sync_interval_seconds):
            problem = None
            try:
                with sessions() as session:
                    ids = list(session.scalars(select(Invoice.id).where(Invoice.status.in_(["issued", "on_plan", "disputed"]))))
                for invoice_id in ids:
                    with sessions() as session:
                        invoice = session.get(Invoice, invoice_id)
                        try:
                            invoices.sync(session, invoice, paypal)
                            session.commit()
                        except PayPalError as error:
                            session.rollback()
                            problem = str(error)[:200]
            except Exception as error:  # keep the loop alive; the next round tries again
                log.exception("Payment sync failed")
                problem = type(error).__name__
            # The owner sees this as a status light, so a silent failure can't pass unnoticed.
            if problem:
                sync_state["last_error"] = problem
            else:
                sync_state["last_ok_at"] = now_text()
                sync_state["last_error"] = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        thread = None
        if settings.sync_interval_seconds > 0:
            thread = threading.Thread(target=sync_loop, name="paypal-sync", daemon=True)
            thread.start()
        yield
        stop_sync.set()

    app = FastAPI(title="PaidLoop", lifespan=lifespan)
    app.state.paypal = paypal
    app.state.sessions = sessions

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.exception_handler(LocalizedError)
    async def _localized_error(request, error):
        return JSONResponse(status_code=error.status, content={"detail": error.message(language_of(request))})

    @app.exception_handler(InvalidTransition)
    async def _transition_error(request, _error):
        text = Text("This step is not possible in the invoice's current state. Please reload the page.",
                    "Dieser Schritt ist im aktuellen Status der Rechnung nicht möglich. Bitte laden Sie die Seite neu.")
        return JSONResponse(status_code=409, content={"detail": text.get(language_of(request))})

    @app.exception_handler(PayPalError)
    async def _paypal_error(request, error):
        text = Text(f"PayPal problem: {error}", f"PayPal-Problem: {error}")
        return JSONResponse(status_code=502, content={"detail": text.get(language_of(request))})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request, error):
        text = Text("Please check the values you entered.", "Bitte prüfen Sie Ihre Eingaben.")
        fields = [".".join(str(part) for part in item["loc"][1:]) for item in error.errors()]
        return JSONResponse(status_code=422, content={"detail": text.get(language_of(request)), "fields": fields})

    def get_session() -> Iterator[Session]:
        with sessions() as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    def invoice_or_404(session: Session, invoice_id: int) -> Invoice:
        invoice = session.get(Invoice, invoice_id)
        if invoice is None:
            raise LocalizedError(Text("Invoice not found.", "Rechnung nicht gefunden."), 404)
        return invoice

    def by_token(session: Session, token: str) -> Invoice:
        invoice = session.scalar(select(Invoice).where(Invoice.public_token == token)) if len(token) >= 20 else None
        if invoice is None:
            raise LocalizedError(Text("This link is not valid.", "Dieser Link ist nicht gültig."), 404)
        return invoice

    @app.get("/api/health")
    def health(session: Session = Depends(get_session, scope="function")) -> dict:
        return {
            "pending_approvals": session.scalar(select(func.count(Proposal.id)).where(Proposal.status == "pending")),
            "sync": {**sync_state, "interval_seconds": settings.sync_interval_seconds},
            "status": "ok",
            "paypal_mode": "simulated" if getattr(paypal, "simulated", False) else "sandbox",
            "paypal_keys_set": settings.has_paypal_keys,
            "ai": ai.status(),
            "ai_model_set": bool(settings.ollama_model),
            "webhook_configured": bool(settings.paypal_webhook_id),
        }

    # Business and customers

    @app.get("/api/business")
    def get_business(session: Session = Depends(get_session, scope="function")) -> dict:
        return business_json(invoices.business_of(session))

    @app.put("/api/business")
    def put_business(data: BusinessIn, session: Session = Depends(get_session, scope="function")) -> dict:
        business = invoices.business_of(session)
        for key, value in data.model_dump(exclude={"min_installment_eur"}).items():
            setattr(business, key, value)
        business.min_installment_cents = to_cents(data.min_installment_eur)
        audit.record(session, "owner", "settings_changed")
        return business_json(business)

    @app.get("/api/customers")
    def list_customers(
        q: str = Query(default="", max_length=100),
        limit: int = Query(default=200, ge=1, le=500),
        session: Session = Depends(get_session, scope="function"),
    ) -> list[dict]:
        query = select(Customer).order_by(Customer.name_key).limit(limit)
        if q.strip():
            query = query.where(Customer.name_key.contains(name_key(q), autoescape=True))
        return [customer_json(c) for c in session.scalars(query)]

    @app.post("/api/customers")
    def add_customer(data: CustomerIn, session: Session = Depends(get_session, scope="function")) -> dict:
        """Typing a known customer again updates them, so the same firm doesn't end up in the list twice."""
        for existing in session.scalars(select(Customer).where(Customer.name_key == name_key(data.name)).order_by(Customer.id)):
            if not existing.email or not data.email or existing.email.casefold() == data.email.casefold():
                for key, value in data.model_dump().items():
                    if value != "":
                        setattr(existing, key, value)
                return customer_json(existing)
        customer = Customer(**data.model_dump())
        session.add(customer)
        session.flush()
        return customer_json(customer)

    @app.put("/api/customers/{customer_id}")
    def edit_customer(customer_id: int, data: CustomerIn, session: Session = Depends(get_session, scope="function")) -> dict:
        customer = session.get(Customer, customer_id)
        if customer is None:
            raise LocalizedError(Text("Customer not found.", "Kunde nicht gefunden."), 404)
        for key, value in data.model_dump().items():
            setattr(customer, key, value)
        return customer_json(customer)

    # Capture

    @app.post("/api/capture/text")
    def capture_from_text(data: TextIn, session: Session = Depends(get_session, scope="function")) -> dict:
        return capture_json(session, capture.capture_text(data.text, ai))

    @app.post("/api/capture/file")
    def capture_from_file(file: UploadFile = File(...), session: Session = Depends(get_session, scope="function")) -> dict:
        content = file.file.read(capture.MAX_FILE_BYTES + 1)
        return capture_json(session, capture.capture_text(capture.text_from_file(content, file.filename or ""), ai))

    # Invoices

    def to_lines(lines: list[LineIn]) -> list[LineInput]:
        return [
            LineInput(l.description, round(l.quantity * 1000), l.unit, to_cents(l.unit_price_eur), round(l.vat_percent * 100))
            for l in lines
        ]

    def overdue_condition(on: date):
        late_plan_payment = exists().where(
            PaymentPlan.invoice_id == Invoice.id,
            PaymentPlan.status == "active",
            Installment.plan_id == PaymentPlan.id,
            Installment.paid_cents < Installment.amount_cents,
            Installment.due_date < on,
        )
        return or_(
            and_(Invoice.status.in_(["issued", "disputed"]), Invoice.due_date < on),
            and_(Invoice.status == "on_plan", late_plan_payment),
        )

    def filter_condition(name: str, on: date):
        if name == "open":
            return Invoice.status.in_(["issued", "on_plan", "disputed"])
        if name == "overdue":
            return overdue_condition(on)
        if name == "draft":
            return Invoice.status.in_(["draft", "checked"])
        if name in {"on_plan", "disputed", "paid", "cancelled"}:
            return Invoice.status == name
        return None

    def invoice_counts(session: Session, on: date) -> dict:
        by_status = dict(session.execute(select(Invoice.status, func.count(Invoice.id)).group_by(Invoice.status)).all())
        return {
            "all": sum(by_status.values()),
            "open": sum(by_status.get(status, 0) for status in ("issued", "on_plan", "disputed")),
            "overdue": session.scalar(select(func.count(Invoice.id)).where(overdue_condition(on))),
            "on_plan": by_status.get("on_plan", 0),
            "disputed": by_status.get("disputed", 0),
            "draft": by_status.get("draft", 0) + by_status.get("checked", 0),
            "paid": by_status.get("paid", 0),
            "cancelled": by_status.get("cancelled", 0),
        }

    @app.get("/api/invoices")
    def list_invoices(
        filter: str = Query(default="all", max_length=20),
        q: str = Query(default="", max_length=100),
        sort: str = Query(default="newest", pattern="^(newest|number|customer|due|amount)$"),
        dir: str = Query(default="desc", pattern="^(asc|desc)$"),
        page: int = Query(default=1, ge=1, le=1000000),
        size: int = Query(default=25, ge=1, le=100),
        session: Session = Depends(get_session, scope="function"),
    ) -> dict:
        """One page at a time. Filters and sorting use indexes, so this stays fast with many invoices."""
        on = invoices.today(session)
        conditions = []
        condition = filter_condition(filter if filter in LIST_FILTERS else "all", on)
        if condition is not None:
            conditions.append(condition)
        text = q.strip()
        if text:
            matching = select(Customer.id).where(Customer.name_key.contains(name_key(text), autoescape=True))
            conditions.append(or_(Invoice.number.contains(text, autoescape=True), Invoice.customer_id.in_(matching)))

        total = session.scalar(select(func.count(Invoice.id)).where(*conditions))
        column = {"newest": Invoice.id, "number": Invoice.number, "customer": Customer.name_key,
                  "due": Invoice.due_date, "amount": Invoice.gross_cents}[sort]
        ordered = column.asc() if dir == "asc" else column.desc()
        query = select(Invoice).where(*conditions)
        if sort == "customer":
            query = query.outerjoin(Customer, Invoice.customer_id == Customer.id)
        # The id comes last, so rows with the same value keep one order between pages.
        query = query.order_by(ordered, Invoice.id.desc()).offset((page - 1) * size).limit(size).options(
            selectinload(Invoice.customer), selectinload(Invoice.plans).selectinload(PaymentPlan.installments)
        )
        rows = list(session.scalars(query))
        pending = set(session.scalars(
            select(Proposal.invoice_id).where(Proposal.status == "pending", Proposal.invoice_id.in_([row.id for row in rows]))
        )) if rows else set()
        return {
            "items": [invoice_summary(session, row, on, pending) for row in rows],
            "total": total,
            "page": page,
            "size": size,
            "counts": invoice_counts(session, on),
        }

    @app.post("/api/invoices")
    def create_invoice(data: DraftIn, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoices.save_draft(session, None, data.customer_id, to_lines(data.lines),
                                      data.issue_date or invoices.today(session), data.service_date, data.due_date,
                                      data.property_work, data.source_text, data.capture_source)
        return invoice_detail(session, invoice, language_of(request))

    @app.put("/api/invoices/{invoice_id}")
    def update_invoice(invoice_id: int, data: DraftIn, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.save_draft(session, invoice, data.customer_id, to_lines(data.lines), data.issue_date,
                            data.service_date, data.due_date, data.property_work)
        return invoice_detail(session, invoice, language_of(request))

    @app.delete("/api/invoices/{invoice_id}")
    def delete_invoice(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoices.delete_draft(session, invoice_or_404(session, invoice_id))
        return {"status": "deleted"}

    @app.get("/api/invoices/{invoice_id}")
    def get_invoice(invoice_id: int, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        return invoice_detail(session, invoice, language_of(request))

    @app.post("/api/invoices/{invoice_id}/check")
    def check_invoice(invoice_id: int, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        return check_json(invoices.run_check(session, invoice_or_404(session, invoice_id)), language_of(request))

    @app.post("/api/invoices/{invoice_id}/issue")
    def issue_invoice(invoice_id: int, request: Request, data: IssueIn | None = None,
                      session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.issue(session, invoice, paypal, public_base)
        if data and data.seconds_to_issue is not None:
            invoice.seconds_to_issue = data.seconds_to_issue
        return invoice_detail(session, invoice, language_of(request))

    @app.post("/api/invoices/{invoice_id}/sync")
    def sync_invoice(invoice_id: int, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.sync(session, invoice, paypal)
        return invoice_detail(session, invoice, language_of(request))

    @app.post("/api/invoices/{invoice_id}/record-payment")
    def record_payment(invoice_id: int, data: PaymentIn, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        """For bank transfers. Many customers still pay outside PayPal, and the app must know."""
        invoice = invoice_or_404(session, invoice_id)
        amount = to_cents(data.amount_eur)
        if invoice.status not in {"issued", "disputed"} or not invoice.paypal_id:
            raise LocalizedError(Text("A payment can only be recorded on an open invoice without a plan.",
                                      "Eine Zahlung kann nur bei einer offenen Rechnung ohne Plan erfasst werden."))
        if amount > invoice.open_cents:
            raise LocalizedError(Text("The amount is higher than what is open.", "Der Betrag ist höher als der offene Betrag."))
        paypal.record_payment(invoice.paypal_id, amount, data.paid_on or date.today(), "Recorded by the owner")
        audit.record(session, "owner", "bank_payment_recorded", invoice.id, amount_cents=amount)
        invoices.sync(session, invoice, paypal)
        return invoice_detail(session, invoice, language_of(request))

    @app.post("/api/invoices/{invoice_id}/cancel")
    def cancel_invoice(invoice_id: int, data: CancelIn, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.cancel(session, invoice, paypal, data.reason)
        return invoice_detail(session, invoice, language_of(request))

    def _file(content: bytes | None, media: str, name: str) -> Response:
        if not content:
            raise LocalizedError(Text("This file does not exist yet.", "Diese Datei gibt es noch nicht."), 404)
        safe = "".join(c for c in name if c.isalnum() or c in "-_.")
        return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{safe}"'})

    @app.get("/api/invoices/{invoice_id}/pdf")
    def invoice_pdf(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> Response:
        invoice = invoice_or_404(session, invoice_id)
        return _file(invoice.pdf, "application/pdf", f"{invoice.number}.pdf")

    @app.get("/api/invoices/{invoice_id}/xml")
    def invoice_xml(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> Response:
        invoice = invoice_or_404(session, invoice_id)
        return _file(invoice.xml, "application/xml", f"{invoice.number}.xml")

    @app.get("/api/invoices/{invoice_id}/credit-note")
    def credit_note_pdf(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> Response:
        invoice = invoice_or_404(session, invoice_id)
        return _file(invoice.credit_note_pdf, "application/pdf", f"{invoice.credit_note_number}.pdf")

    # Follow-up agent and approvals

    @app.post("/api/agent/run")
    def run_agent(request: Request, session: Session = Depends(get_session, scope="function")) -> list[dict]:
        language = language_of(request)
        return [{**vars(outcome), "reason": pick(outcome.reason, language)} for outcome in followup.run(session, paypal, ai, public_base)]

    @app.get("/api/approvals")
    def approvals(request: Request, session: Session = Depends(get_session, scope="function")) -> list[dict]:
        on = invoices.today(session)
        language = language_of(request)
        rows = session.scalars(
            select(Proposal).where(Proposal.status == "pending").order_by(Proposal.id).options(
                selectinload(Proposal.invoice).options(
                    selectinload(Invoice.customer),
                    selectinload(Invoice.proposals),
                    selectinload(Invoice.plans).selectinload(PaymentPlan.installments),
                )
            )
        )
        return [proposal_json(session, proposal, on, language) for proposal in rows]

    def proposal_or_404(session: Session, proposal_id: int) -> Proposal:
        proposal = session.get(Proposal, proposal_id)
        if proposal is None:
            raise LocalizedError(NOT_FOUND, 404)
        return proposal

    @app.post("/api/approvals/{proposal_id}/approve")
    def approve(proposal_id: int, data: ApproveIn, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        return {"message": pick(followup.approve(session, proposal_or_404(session, proposal_id), paypal, data.body), language_of(request))}

    @app.post("/api/approvals/{proposal_id}/reject")
    def reject(proposal_id: int, request: Request, session: Session = Depends(get_session, scope="function")) -> dict:
        return {"message": pick(followup.reject(session, proposal_or_404(session, proposal_id)), language_of(request))}

    # Dashboard and audit

    @app.get("/api/dashboard")
    def get_dashboard(session: Session = Depends(get_session, scope="function")) -> dict:
        return dashboard.build(session)

    @app.get("/api/ledger")
    def get_ledger(session: Session = Depends(get_session, scope="function")) -> dict:
        accounts = [ledger.CASH, ledger.RECEIVABLE, ledger.REVENUE, ledger.VAT_PAYABLE, ledger.VAT_DEFERRED]
        debit, credit = ledger.totals(session)
        return {"accounts": {a: ledger.balance(session, a) for a in accounts}, "debit": debit, "credit": credit}

    @app.get("/api/audit")
    def get_audit(
        invoice_id: int | None = None,
        before_id: int | None = None,
        limit: int = Query(default=50, ge=1, le=200),
        session: Session = Depends(get_session, scope="function"),
    ) -> dict:
        """Newest first. before_id continues from the last row, so old pages are as fast as new ones."""
        query = select(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit + 1)
        if invoice_id:
            query = query.where(AuditEvent.invoice_id == invoice_id)
        if before_id:
            query = query.where(AuditEvent.id < before_id)
        rows = list(session.scalars(query))
        shown = rows[:limit]
        return {
            "events": [
                {"id": e.id, "at": e.at, "actor": e.actor, "action": e.action, "invoice_id": e.invoice_id,
                 "data": json.loads(e.data), "hash": e.hash[:12]}
                for e in shown
            ],
            "next_before_id": shown[-1].id if len(rows) > limit else None,
        }

    @app.get("/api/audit/verify")
    def verify_audit(session: Session = Depends(get_session, scope="function")) -> dict:
        """Reads every row, so it is a separate call from showing the list."""
        return audit.verify(session)

    # Customer pages. The long random token in the link is the only way in.

    def pay_json(session: Session, invoice: Invoice) -> dict:
        business = invoices.business_of(session)
        language = negotiation.language_of_chat(invoice)
        plan = invoice.active_plan
        return {
            "number": invoice.number,
            "status": invoice.status,
            "seller": business.name,
            "customer_name": invoice.customer.name,
            "language": language,
            "gross_cents": invoice.gross_cents,
            "paid_cents": invoice.paid_cents,
            "open_cents": invoice.open_cents,
            "due_date": invoice.due_date,
            "pay_link": None if plan else invoice.pay_link,
            "plan": plan_json(plan),
            "offer": plan_json(invoice.open_offer),
            "messages": [{"role": m.role, "text": m.text} for m in invoice.messages],
            "welcome": negotiation.messages.chat("welcome", language),
            "simulated": getattr(paypal, "simulated", False),
        }

    @app.get("/api/pay/{token}")
    def pay_page(token: str, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = by_token(session, token)
        try:
            invoices.sync(session, invoice, paypal)
        except PayPalError:
            pass  # still show the page; the next visit or background sync catches up
        return pay_json(session, invoice)

    @app.post("/api/pay/{token}/chat")
    def pay_chat(token: str, data: ChatIn, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = by_token(session, token)
        reply = negotiation.handle_message(session, invoice, data.text, ai, paypal)
        return {"reply": reply.text, "intent": reply.intent, "page": pay_json(session, invoice)}

    @app.post("/api/pay/{token}/offers/{plan_id}/accept")
    def accept(token: str, plan_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = by_token(session, token)
        try:
            reply = negotiation.accept_offer(session, invoice, plan_id, paypal)
        except ChatRefused:
            session.commit()  # keep a payment found during the check, or a withdrawn offer
            raise
        return {"reply": reply.text, "page": pay_json(session, invoice)}

    @app.get("/api/pay/{token}/pdf")
    def pay_pdf(token: str, session: Session = Depends(get_session, scope="function")) -> Response:
        invoice = by_token(session, token)
        return _file(invoice.pdf, "application/pdf", f"{invoice.number}.pdf")

    @app.post("/api/pay/{token}/simulate-payment")
    def simulate_payment(token: str, session: Session = Depends(get_session, scope="function")) -> dict:
        """Only exists in simulator mode. It acts as PayPal when no sandbox keys are set."""
        if not getattr(paypal, "simulated", False):
            raise LocalizedError(NOT_FOUND, 404)
        invoice = by_token(session, token)
        plan = invoice.active_plan
        if plan:
            next_one = next((i for i in plan.installments if not i.is_paid), None)
            if next_one:
                paypal.pay(next_one.paypal_id)
        elif invoice.open_cents:
            paypal.pay(invoice.paypal_id)
        invoices.sync(session, invoice, paypal)
        return pay_json(session, invoice)

    # PayPal webhook

    @app.post("/api/paypal/webhook")
    async def webhook(request: Request) -> dict:
        try:
            event = json.loads(await request.body())
        except ValueError as error:
            raise LocalizedError("Not JSON", 400) from error
        if not isinstance(event, dict) or not event.get("id"):
            raise LocalizedError("Not a webhook event", 400)
        headers = {key.lower(): value for key, value in request.headers.items()}
        if not paypal.verify_webhook(settings.paypal_webhook_id, headers, event):
            raise LocalizedError("Signature check failed", 400)
        with sessions() as session:
            if session.scalar(select(WebhookEvent.id).where(WebhookEvent.event_id == event["id"])):
                return {"status": "already handled"}
            session.add(WebhookEvent(event_id=event["id"], event_type=str(event.get("event_type", ""))[:80]))
            resource = event.get("resource") or {}
            paypal_id = resource.get("id") or (resource.get("invoice") or {}).get("id")
            invoice = None
            if paypal_id:
                invoice = session.scalar(select(Invoice).where(Invoice.paypal_id == paypal_id))
                if invoice is None:
                    installment = session.scalar(select(Installment).where(Installment.paypal_id == paypal_id))
                    invoice = installment.plan.invoice if installment else None
            if invoice is not None:
                # The event is only a signal. PayPal's own record decides what was paid.
                invoices.sync(session, invoice, paypal)
            audit.record(session, "paypal", "webhook", invoice.id if invoice else None, event_type=event.get("event_type"))
            session.commit()
        return {"status": "ok"}

    # Demo tools

    @app.post("/api/demo/reset")
    def demo_reset(session: Session = Depends(get_session, scope="function")) -> dict:
        demo.reset(session, paypal, settings.sandbox_buyer_email, public_base)
        return {"status": "ok", "today": invoices.today(session)}

    @app.post("/api/demo/jump")
    def demo_jump(data: JumpIn, session: Session = Depends(get_session, scope="function")) -> dict:
        invoices.set_offset(session, invoices.offset_days(session) + data.days)
        return {"today": invoices.today(session), "offset_days": invoices.offset_days(session)}

    @app.get("/api/demo/clock")
    def demo_clock(session: Session = Depends(get_session, scope="function")) -> dict:
        return {"today": invoices.today(session), "offset_days": invoices.offset_days(session)}

    # Serve the built frontend, so one command runs everything.
    if FRONTEND.exists():
        @app.get("/{path:path}", include_in_schema=False)
        def frontend(path: str) -> Response:
            if path.startswith("api/"):
                raise LocalizedError(NOT_FOUND, 404)
            candidate = (FRONTEND / path).resolve()
            if path and candidate.is_file() and FRONTEND.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(FRONTEND / "index.html")

    return app


app = create_app()
