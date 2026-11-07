"""Database tables. Money is stored as whole cents, VAT rates as basis points (19% = 1900)."""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from paidloop.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Invoice states
DRAFT = "draft"
CHECKED = "checked"
ISSUED = "issued"
ON_PLAN = "on_plan"
DISPUTED = "disputed"
PAID = "paid"
CANCELLED = "cancelled"

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    DRAFT: {CHECKED},
    CHECKED: {DRAFT, ISSUED},
    ISSUED: {ON_PLAN, DISPUTED, PAID, CANCELLED},
    ON_PLAN: {DISPUTED, PAID, CANCELLED},
    DISPUTED: {ISSUED, ON_PLAN, PAID, CANCELLED},
    PAID: set(),
    CANCELLED: set(),
}
OPEN_STATES = {ISSUED, ON_PLAN, DISPUTED}


class InvalidTransition(Exception):
    pass


class Business(Base):
    __tablename__ = "business"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    street: Mapped[str] = mapped_column(String(200), default="")
    postcode: Mapped[str] = mapped_column(String(20), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    country: Mapped[str] = mapped_column(String(2), default="DE")
    vat_id: Mapped[str] = mapped_column(String(30), default="")
    tax_number: Mapped[str] = mapped_column(String(30), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    small_business: Mapped[bool] = mapped_column(Boolean, default=False)  # Sec. 19 UStG
    vat_method: Mapped[str] = mapped_column(String(4), default="soll")  # soll or ist
    invoice_prefix: Mapped[str] = mapped_column(String(20), default="RE")
    next_number: Mapped[int] = mapped_column(Integer, default=1)
    paypal_suffix: Mapped[str] = mapped_column(String(20), default="")

    # Owner limits: the AI can never go outside these.
    max_installments: Mapped[int] = mapped_column(Integer, default=4)
    min_first_payment_pct: Mapped[int] = mapped_column(Integer, default=20)
    max_plan_days: Mapped[int] = mapped_column(Integer, default=90)
    min_installment_cents: Mapped[int] = mapped_column(Integer, default=2000)
    reminder_gap_days: Mapped[int] = mapped_column(Integer, default=7)
    payment_days: Mapped[int] = mapped_column(Integer, default=14)


class Customer(Base):
    __tablename__ = "customer"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    street: Mapped[str] = mapped_column(String(200), default="")
    postcode: Mapped[str] = mapped_column(String(20), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    country: Mapped[str] = mapped_column(String(2), default="DE")
    email: Mapped[str] = mapped_column(String(200), default="")
    is_business: Mapped[bool] = mapped_column(Boolean, default=True)
    language: Mapped[str] = mapped_column(String(2), default="de")
    # Earlier invoices outside this app: average days late and unpaid count, for the risk score.
    history_paid_count: Mapped[int] = mapped_column(Integer, default=0)
    history_avg_days_late: Mapped[int] = mapped_column(Integer, default=0)
    history_unpaid_count: Mapped[int] = mapped_column(Integer, default=0)

    invoices: Mapped[list[Invoice]] = relationship(back_populates="customer")


class Invoice(Base):
    __tablename__ = "invoice"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customer.id"), nullable=True)
    number: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=DRAFT)

    issue_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    service_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    property_work: Mapped[bool] = mapped_column(Boolean, default=False)  # work on a building or land
    source_text: Mapped[str] = mapped_column(Text, default="")
    capture_source: Mapped[str] = mapped_column(String(10), default="")  # ai, rules, manual

    net_cents: Mapped[int] = mapped_column(Integer, default=0)
    vat_cents: Mapped[int] = mapped_column(Integer, default=0)
    gross_cents: Mapped[int] = mapped_column(Integer, default=0)
    paid_cents: Mapped[int] = mapped_column(Integer, default=0)

    paypal_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    paypal_number: Mapped[str | None] = mapped_column(String(60), nullable=True)
    pay_link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    qr_png: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    xml: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    pdf: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    credit_note_number: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True)
    credit_note_xml: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    credit_note_pdf: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    public_token: Mapped[str | None] = mapped_column(String(60), unique=True, nullable=True)

    reminder_level: Mapped[int] = mapped_column(Integer, default=0)
    last_reminder_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    default_since: Mapped[date | None] = mapped_column(Date, nullable=True)
    paused_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    paid_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    customer: Mapped[Customer | None] = relationship(back_populates="invoices")
    lines: Mapped[list[InvoiceLine]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", order_by="InvoiceLine.position"
    )
    payments: Mapped[list[Payment]] = relationship(back_populates="invoice", cascade="all, delete-orphan")
    plans: Mapped[list[PaymentPlan]] = relationship(back_populates="invoice", cascade="all, delete-orphan")
    proposals: Mapped[list[Proposal]] = relationship(back_populates="invoice", cascade="all, delete-orphan")
    messages: Mapped[list[ChatMessage]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", order_by="ChatMessage.id"
    )

    def move_to(self, new_status: str) -> None:
        if new_status == self.status:
            return
        if new_status not in ALLOWED_TRANSITIONS[self.status]:
            raise InvalidTransition(f"An invoice cannot go from {self.status} to {new_status}")
        self.status = new_status

    @property
    def open_cents(self) -> int:
        return max(self.gross_cents - self.paid_cents, 0)

    @property
    def active_plan(self) -> PaymentPlan | None:
        return next((plan for plan in self.plans if plan.status == "active"), None)

    @property
    def open_offer(self) -> PaymentPlan | None:
        return next((plan for plan in self.plans if plan.status == "offered"), None)


class InvoiceLine(Base):
    __tablename__ = "invoice_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoice.id"))
    position: Mapped[int] = mapped_column(Integer, default=1)
    description: Mapped[str] = mapped_column(String(300), default="")
    quantity_milli: Mapped[int] = mapped_column(Integer, default=1000)
    unit: Mapped[str] = mapped_column(String(3), default="H87")  # HUR hours, H87 pieces
    unit_price_cents: Mapped[int] = mapped_column(Integer, default=0)
    vat_bp: Mapped[int] = mapped_column(Integer, default=1900)
    net_cents: Mapped[int] = mapped_column(Integer, default=0)

    invoice: Mapped[Invoice] = relationship(back_populates="lines")


class Payment(Base):
    __tablename__ = "payment"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoice.id"))
    external_id: Mapped[str] = mapped_column(String(80), unique=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    paid_on: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(40), default="")

    invoice: Mapped[Invoice] = relationship(back_populates="payments")


class PaymentPlan(Base):
    __tablename__ = "payment_plan"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoice.id"))
    status: Mapped[str] = mapped_column(String(12), default="offered")  # offered active done declined
    created_by: Mapped[str] = mapped_column(String(10), default="agent")  # agent or owner
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    invoice: Mapped[Invoice] = relationship(back_populates="plans")
    installments: Mapped[list[Installment]] = relationship(
        back_populates="plan", cascade="all, delete-orphan", order_by="Installment.seq"
    )


class Installment(Base):
    __tablename__ = "installment"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("payment_plan.id"))
    seq: Mapped[int] = mapped_column(Integer)
    amount_cents: Mapped[int] = mapped_column(Integer)
    due_date: Mapped[date] = mapped_column(Date)
    paypal_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    paypal_number: Mapped[str | None] = mapped_column(String(60), nullable=True)
    pay_link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    paid_cents: Mapped[int] = mapped_column(Integer, default=0)

    plan: Mapped[PaymentPlan] = relationship(back_populates="installments")

    @property
    def is_paid(self) -> bool:
        return self.paid_cents >= self.amount_cents


class Proposal(Base):
    """Something the agent wants to do. Serious steps wait here for the owner."""

    __tablename__ = "proposal"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoice.id"))
    action: Mapped[str] = mapped_column(String(30))
    reason: Mapped[str] = mapped_column(Text, default="")
    decided_by_ai: Mapped[bool] = mapped_column(Boolean, default=False)
    subject: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending approved rejected done obsolete
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    invoice: Mapped[Invoice] = relationship(back_populates="proposals")


class ChatMessage(Base):
    __tablename__ = "chat_message"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoice.id"))
    role: Mapped[str] = mapped_column(String(10))  # customer or agent
    text: Mapped[str] = mapped_column(Text)
    intent: Mapped[str] = mapped_column(String(30), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    invoice: Mapped[Invoice] = relationship(back_populates="messages")


class JournalEntry(Base):
    __tablename__ = "journal_entry"

    id: Mapped[int] = mapped_column(primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(String(300), default="")
    invoice_id: Mapped[int | None] = mapped_column(ForeignKey("invoice.id"), nullable=True)
    booked_on: Mapped[date] = mapped_column(Date)
    lines: Mapped[list[JournalLine]] = relationship(cascade="all, delete-orphan")


class JournalLine(Base):
    __tablename__ = "journal_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("journal_entry.id"))
    account: Mapped[str] = mapped_column(String(30))
    debit_cents: Mapped[int] = mapped_column(Integer, default=0)
    credit_cents: Mapped[int] = mapped_column(Integer, default=0)


class AuditEvent(Base):
    """Append-only log. Each row includes the hash of the row before it."""

    __tablename__ = "audit_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(12))  # ai rules owner customer paypal system
    action: Mapped[str] = mapped_column(String(50))
    invoice_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    data: Mapped[str] = mapped_column(Text, default="{}")
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class WebhookEvent(Base):
    __tablename__ = "webhook_event"
    __table_args__ = (UniqueConstraint("event_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str] = mapped_column(String(80))
    event_type: Mapped[str] = mapped_column(String(80), default="")
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppState(Base):
    __tablename__ = "app_state"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
