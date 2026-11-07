"""PaidLoop API. It runs on your own computer, and only /api/pay/... is meant for customers."""

from __future__ import annotations

import json
import logging
import threading
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from paidloop import audit, capture, dashboard, demo, followup, invoices, ledger, legal, negotiation
from paidloop.ai import AI, LocalAI, NoAI
from paidloop.db import Base, make_engine, make_session_factory
from paidloop.invoices import InvoiceError, LineInput
from paidloop.models import (
    ALLOWED_TRANSITIONS,
    AuditEvent,
    Business,
    Customer,
    InvalidTransition,
    Invoice,
    Installment,
    Proposal,
    WebhookEvent,
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


def invoice_summary(session: Session, invoice: Invoice, on: date) -> dict:
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
        "has_pending": any(p.status == "pending" for p in invoice.proposals),
    }


def invoice_detail(session: Session, invoice: Invoice) -> dict:
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
        data["risk"] = {"score": assessed.score, "level": assessed.level, "reasons": list(assessed.reasons),
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


def proposal_json(session: Session, proposal: Proposal, on: date) -> dict:
    payload = json.loads(proposal.payload or "{}")
    return {
        "id": proposal.id,
        "action": proposal.action,
        "reason": proposal.reason,
        "decided_by_ai": proposal.decided_by_ai,
        "subject": proposal.subject,
        "body": proposal.body,
        "english": payload.get("english", ""),
        "status": proposal.status,
        "created_at": proposal.created_at,
        "invoice": invoice_summary(session, proposal.invoice, on),
    }


def check_json(result) -> dict:
    return {
        "can_issue": result.can_issue,
        "issues": [vars(issue) if hasattr(issue, "__dict__") else issue.__dict__ for issue in result.issues],
        "notes_to_print": result.notes_to_print,
    }


def capture_json(session: Session, result: capture.CaptureResult) -> dict:
    extracted = result.extracted
    known = None
    if extracted.customer_name:
        first = extracted.customer_name.split()[0].lower()
        for customer in session.scalars(select(Customer)):
            if first in customer.name.lower():
                known = customer_json(customer)
                break
    business = invoices.business_of(session)
    return {
        "source": result.source,
        "source_text": result.source_text,
        "extracted": extracted.model_dump(),
        "unsure": result.unsure,
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
                   REPO_ROOT / "data" / "ai_answers.json")


def create_app(settings: Settings | None = None, paypal=None, ai: AI | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    Base.metadata.create_all(engine)
    sessions = make_session_factory(engine)
    paypal = paypal if paypal is not None else build_paypal(settings)
    ai = ai if ai is not None else build_ai(settings)
    public_base = settings.public_base_url.rstrip("/")
    stop_sync = threading.Event()

    def sync_loop() -> None:
        """Payment updates work without a public webhook address, because the app asks PayPal itself."""
        while not stop_sync.wait(settings.sync_interval_seconds):
            try:
                with sessions() as session:
                    ids = list(session.scalars(select(Invoice.id).where(Invoice.status.in_(["issued", "on_plan", "disputed"]))))
                for invoice_id in ids:
                    with sessions() as session:
                        invoice = session.get(Invoice, invoice_id)
                        try:
                            invoices.sync(session, invoice, paypal)
                            session.commit()
                        except PayPalError:
                            session.rollback()
            except Exception:  # keep the loop alive; the next round tries again
                log.exception("Payment sync failed")

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

    @app.exception_handler(InvoiceError)
    async def _invoice_error(_request, error):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.exception_handler(InvalidTransition)
    async def _transition_error(_request, error):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(ChatRefused)
    async def _chat_error(_request, error):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.exception_handler(PayPalError)
    async def _paypal_error(_request, error):
        return JSONResponse(status_code=502, content={"detail": f"PayPal problem: {error}"})

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
            raise HTTPException(404, "Invoice not found")
        return invoice

    def by_token(session: Session, token: str) -> Invoice:
        invoice = session.scalar(select(Invoice).where(Invoice.public_token == token)) if len(token) >= 20 else None
        if invoice is None:
            raise HTTPException(404, "This link is not valid.")
        return invoice

    @app.get("/api/health")
    def health() -> dict:
        return {
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
    def list_customers(session: Session = Depends(get_session, scope="function")) -> list[dict]:
        return [customer_json(c) for c in session.scalars(select(Customer).order_by(Customer.name))]

    @app.post("/api/customers")
    def add_customer(data: CustomerIn, session: Session = Depends(get_session, scope="function")) -> dict:
        customer = Customer(**data.model_dump())
        session.add(customer)
        session.flush()
        return customer_json(customer)

    @app.put("/api/customers/{customer_id}")
    def edit_customer(customer_id: int, data: CustomerIn, session: Session = Depends(get_session, scope="function")) -> dict:
        customer = session.get(Customer, customer_id)
        if customer is None:
            raise HTTPException(404, "Customer not found")
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
        try:
            text = capture.text_from_file(content, file.filename or "")
        except capture.UnreadableFile as error:
            raise HTTPException(422, str(error)) from error
        return capture_json(session, capture.capture_text(text, ai))

    # Invoices

    def to_lines(lines: list[LineIn]) -> list[LineInput]:
        return [
            LineInput(l.description, round(l.quantity * 1000), l.unit, to_cents(l.unit_price_eur), round(l.vat_percent * 100))
            for l in lines
        ]

    @app.get("/api/invoices")
    def list_invoices(session: Session = Depends(get_session, scope="function")) -> list[dict]:
        on = invoices.today(session)
        rows = session.scalars(select(Invoice).order_by(Invoice.id.desc()))
        return [invoice_summary(session, invoice, on) for invoice in rows]

    @app.post("/api/invoices")
    def create_invoice(data: DraftIn, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoices.save_draft(session, None, data.customer_id, to_lines(data.lines),
                                      data.issue_date or invoices.today(session), data.service_date, data.due_date,
                                      data.property_work, data.source_text, data.capture_source)
        return invoice_detail(session, invoice)

    @app.put("/api/invoices/{invoice_id}")
    def update_invoice(invoice_id: int, data: DraftIn, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.save_draft(session, invoice, data.customer_id, to_lines(data.lines), data.issue_date,
                            data.service_date, data.due_date, data.property_work)
        return invoice_detail(session, invoice)

    @app.get("/api/invoices/{invoice_id}")
    def get_invoice(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        return invoice_detail(session, invoice)

    @app.post("/api/invoices/{invoice_id}/check")
    def check_invoice(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        return check_json(invoices.run_check(session, invoice_or_404(session, invoice_id)))

    @app.post("/api/invoices/{invoice_id}/issue")
    def issue_invoice(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.issue(session, invoice, paypal, public_base)
        return invoice_detail(session, invoice)

    @app.post("/api/invoices/{invoice_id}/sync")
    def sync_invoice(invoice_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.sync(session, invoice, paypal)
        return invoice_detail(session, invoice)

    @app.post("/api/invoices/{invoice_id}/record-payment")
    def record_payment(invoice_id: int, data: PaymentIn, session: Session = Depends(get_session, scope="function")) -> dict:
        """For bank transfers. Many customers still pay outside PayPal, and the app must know."""
        invoice = invoice_or_404(session, invoice_id)
        amount = to_cents(data.amount_eur)
        if invoice.status not in {"issued", "disputed"} or not invoice.paypal_id:
            raise HTTPException(422, "A payment can only be recorded on an open invoice without a plan.")
        if amount > invoice.open_cents:
            raise HTTPException(422, "The amount is higher than what is open.")
        paypal.record_payment(invoice.paypal_id, amount, data.paid_on or date.today(), "Recorded by the owner")
        audit.record(session, "owner", "bank_payment_recorded", invoice.id, amount_cents=amount)
        invoices.sync(session, invoice, paypal)
        return invoice_detail(session, invoice)

    @app.post("/api/invoices/{invoice_id}/cancel")
    def cancel_invoice(invoice_id: int, data: CancelIn, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = invoice_or_404(session, invoice_id)
        invoices.cancel(session, invoice, paypal, data.reason)
        return invoice_detail(session, invoice)

    def _file(content: bytes | None, media: str, name: str) -> Response:
        if not content:
            raise HTTPException(404, "This file does not exist yet.")
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

    # Follow-up agent and approvals

    @app.post("/api/agent/run")
    def run_agent(session: Session = Depends(get_session, scope="function")) -> list[dict]:
        return [vars(outcome) for outcome in followup.run(session, paypal, ai, public_base)]

    @app.get("/api/approvals")
    def approvals(session: Session = Depends(get_session, scope="function")) -> list[dict]:
        on = invoices.today(session)
        rows = session.scalars(select(Proposal).where(Proposal.status == "pending").order_by(Proposal.id))
        return [proposal_json(session, proposal, on) for proposal in rows]

    def proposal_or_404(session: Session, proposal_id: int) -> Proposal:
        proposal = session.get(Proposal, proposal_id)
        if proposal is None:
            raise HTTPException(404, "Not found")
        return proposal

    @app.post("/api/approvals/{proposal_id}/approve")
    def approve(proposal_id: int, data: ApproveIn, session: Session = Depends(get_session, scope="function")) -> dict:
        return {"message": followup.approve(session, proposal_or_404(session, proposal_id), paypal, data.body)}

    @app.post("/api/approvals/{proposal_id}/reject")
    def reject(proposal_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        return {"message": followup.reject(session, proposal_or_404(session, proposal_id))}

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
    def get_audit(invoice_id: int | None = None, session: Session = Depends(get_session, scope="function")) -> dict:
        query = select(AuditEvent).order_by(AuditEvent.id.desc()).limit(200)
        if invoice_id:
            query = query.where(AuditEvent.invoice_id == invoice_id)
        events = [
            {"id": e.id, "at": e.at, "actor": e.actor, "action": e.action, "invoice_id": e.invoice_id,
             "data": json.loads(e.data), "hash": e.hash[:12]}
            for e in session.scalars(query)
        ]
        return {"events": events, "chain": audit.verify(session)}

    # Customer pages. The long random token in the link is the only way in.

    def pay_json(session: Session, invoice: Invoice) -> dict:
        business = invoices.business_of(session)
        language = invoice.customer.language
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
        try:
            reply = negotiation.handle_message(session, invoice, data.text, ai, paypal)
        except ChatRefused as error:
            status = 429 if "Too many" in str(error) else 422
            raise HTTPException(status, str(error)) from error
        return {"reply": reply.text, "intent": reply.intent, "page": pay_json(session, invoice)}

    @app.post("/api/pay/{token}/offers/{plan_id}/accept")
    def accept(token: str, plan_id: int, session: Session = Depends(get_session, scope="function")) -> dict:
        invoice = by_token(session, token)
        try:
            reply = negotiation.accept_offer(session, invoice, plan_id, paypal)
        except ChatRefused as error:
            session.commit()  # keep a payment found during the check, or a withdrawn offer
            raise HTTPException(422, str(error)) from error
        return {"reply": reply.text, "page": pay_json(session, invoice)}

    @app.get("/api/pay/{token}/pdf")
    def pay_pdf(token: str, session: Session = Depends(get_session, scope="function")) -> Response:
        invoice = by_token(session, token)
        return _file(invoice.pdf, "application/pdf", f"{invoice.number}.pdf")

    @app.post("/api/pay/{token}/simulate-payment")
    def simulate_payment(token: str, session: Session = Depends(get_session, scope="function")) -> dict:
        """Only exists in simulator mode. It acts as PayPal when no sandbox keys are set."""
        if not getattr(paypal, "simulated", False):
            raise HTTPException(404, "Not available")
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
            raise HTTPException(400, "Not JSON") from error
        if not isinstance(event, dict) or not event.get("id"):
            raise HTTPException(400, "Not a webhook event")
        headers = {key.lower(): value for key, value in request.headers.items()}
        if not paypal.verify_webhook(settings.paypal_webhook_id, headers, event):
            raise HTTPException(400, "Signature check failed")
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
                raise HTTPException(404, "Not found")
            candidate = (FRONTEND / path).resolve()
            if path and candidate.is_file() and FRONTEND.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(FRONTEND / "index.html")

    return app


app = create_app()
