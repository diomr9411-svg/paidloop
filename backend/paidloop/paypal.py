"""PayPal Invoicing client, plus a simulator for running without keys and for tests.

Never logs keys or tokens. The real client can only talk to the sandbox (see settings.py).
"""

from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import httpx

from paidloop.money import to_decimal


class PayPalError(Exception):
    def __init__(self, message: str, status: int = 0, issue: str = "", debug_id: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.issue = issue
        self.debug_id = debug_id


@dataclass(frozen=True)
class RequestLine:
    name: str
    quantity: str
    unit_price_cents: int
    vat_percent: str | None = None
    hours: bool = False


@dataclass(frozen=True)
class PaymentRequest:
    number: str
    issue_date: date
    due_date: date
    note: str
    recipient_name: str
    recipient_email: str
    lines: tuple[RequestLine, ...]
    invoicer_name: str = ""


@dataclass(frozen=True)
class Transaction:
    external_id: str
    amount_cents: int
    paid_on: date
    method: str


@dataclass(frozen=True)
class InvoiceState:
    paypal_id: str
    status: str
    paid_cents: int
    due_cents: int
    transactions: tuple[Transaction, ...]
    pay_link: str | None


def _cents(amount: dict | None) -> int:
    from paidloop.money import to_cents

    return to_cents(amount.get("value", "0")) if amount else 0


def _parse_state(body: dict) -> InvoiceState:
    payments = body.get("payments") or {}
    transactions = []
    for item in payments.get("transactions") or []:
        external_id = item.get("payment_id")
        if not external_id:
            continue
        day = (item.get("payment_date") or "")[:10]
        transactions.append(
            Transaction(
                external_id=external_id,
                amount_cents=_cents(item.get("amount")),
                paid_on=date.fromisoformat(day) if day else date.today(),
                method=item.get("method") or "",
            )
        )
    metadata = (body.get("detail") or {}).get("metadata") or {}
    return InvoiceState(
        paypal_id=body["id"],
        status=body.get("status", ""),
        paid_cents=_cents(payments.get("paid_amount")),
        due_cents=_cents(body.get("due_amount")),
        transactions=tuple(transactions),
        pay_link=metadata.get("recipient_view_url"),
    )


def _parse_qr(response: httpx.Response) -> bytes | None:
    """PayPal returns the PNG as base64 text inside a multipart body."""
    content_type = response.headers.get("content-type", "")
    text = response.text
    if "multipart" in content_type:
        parts = text.split("\r\n\r\n", 1) if "\r\n\r\n" in text else text.split("\n\n", 1)
        if len(parts) != 2:
            return None
        text = parts[1].split("--", 1)[0]
    try:
        return base64.b64decode(text.strip(), validate=False) or None
    except ValueError:
        return None


class PayPalClient:
    simulated = False

    def __init__(self, base_url: str, client_id: str, client_secret: str, http: httpx.Client | None = None) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http or httpx.Client(base_url=base_url, timeout=45)
        self._token: str | None = None
        self._token_expires = 0.0
        self._lock = threading.Lock()

    def _access_token(self) -> str:
        with self._lock:
            if self._token and time.monotonic() < self._token_expires:
                return self._token
            try:
                response = self._http.post(
                    "/v1/oauth2/token",
                    auth=(self._client_id, self._client_secret),
                    data={"grant_type": "client_credentials"},
                )
            except httpx.HTTPError as error:
                raise PayPalError(f"PayPal cannot be reached: {type(error).__name__}") from error
            if response.status_code != 200:
                raise PayPalError("PayPal refused the sandbox keys", status=response.status_code)
            body = response.json()
            self._token = body["access_token"]
            self._token_expires = time.monotonic() + max(int(body.get("expires_in", 300)) - 60, 30)
            return self._token

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}))
        # The same request ID on every retry stops PayPal from doing the work twice.
        if method != "GET":
            headers.setdefault("PayPal-Request-Id", str(uuid.uuid4()))
        last_error: Exception | None = None
        for attempt in range(3):
            headers["Authorization"] = f"Bearer {self._access_token()}"
            try:
                response = self._http.request(method, path, headers=headers, **kwargs)
            except httpx.TimeoutException as error:
                last_error = error
                time.sleep(attempt + 1)
                continue
            except httpx.HTTPError as error:
                raise PayPalError(f"PayPal cannot be reached: {type(error).__name__}") from error
            if response.status_code == 401 and attempt == 0:
                self._token = None
                continue
            if response.status_code >= 500 and attempt < 2:
                time.sleep(attempt + 1)
                continue
            if response.status_code >= 400:
                raise self._error(response)
            return response
        raise PayPalError(f"PayPal did not answer in time: {type(last_error).__name__}")

    @staticmethod
    def _error(response: httpx.Response) -> PayPalError:
        issue, debug_id, message = "", response.headers.get("paypal-debug-id", ""), response.text[:200]
        try:
            body = response.json()
            details = body.get("details") or [{}]
            issue = details[0].get("issue", "")
            message = details[0].get("description") or body.get("message") or message
            debug_id = body.get("debug_id", debug_id)
        except ValueError:
            pass
        return PayPalError(message, status=response.status_code, issue=issue, debug_id=debug_id)

    def create_invoice(self, request: PaymentRequest) -> str:
        items = []
        for line in request.lines:
            item = {
                "name": line.name[:200],
                "quantity": line.quantity,
                "unit_amount": {"currency_code": "EUR", "value": str(to_decimal(line.unit_price_cents))},
                "unit_of_measure": "HOURS" if line.hours else "QUANTITY",
            }
            if line.vat_percent:
                item["tax"] = {"name": "VAT", "percent": line.vat_percent}
            items.append(item)
        body = {
            "detail": {
                "invoice_number": request.number,
                "invoice_date": request.issue_date.isoformat(),
                "currency_code": "EUR",
                "note": request.note[:4000],
                "payment_term": {"term_type": "DUE_ON_DATE_SPECIFIED", "due_date": request.due_date.isoformat()},
            },
            "primary_recipients": [
                {
                    "billing_info": {
                        "business_name": request.recipient_name[:300],
                        "email_address": request.recipient_email,
                    }
                }
            ],
            "items": items,
            "configuration": {"allow_tip": False, "tax_inclusive": False},
        }
        if request.invoicer_name:
            body["invoicer"] = {"business_name": request.invoicer_name[:300]}
        try:
            response = self._request(
                "POST", "/v2/invoicing/invoices", json=body, headers={"Prefer": "return=representation"}
            )
        except PayPalError as error:
            if error.issue == "DUPLICATE_INVOICE_NUMBER":
                # A retry after a crash. Use the invoice that already exists instead of making a second one.
                existing = self.find_by_number(request.number)
                if existing:
                    return existing
            raise
        return response.json()["id"]

    def send(self, paypal_id: str, notify_customer: bool = True) -> None:
        self._request(
            "POST",
            f"/v2/invoicing/invoices/{paypal_id}/send",
            json={"send_to_invoicer": False, "send_to_recipient": notify_customer},
        )

    def get(self, paypal_id: str) -> InvoiceState:
        return _parse_state(self._request("GET", f"/v2/invoicing/invoices/{paypal_id}").json())

    def qr_code(self, paypal_id: str) -> bytes | None:
        response = self._request(
            "POST",
            f"/v2/invoicing/invoices/{paypal_id}/generate-qr-code",
            json={"width": 300, "height": 300, "action": "pay"},
        )
        return _parse_qr(response)

    def remind(self, paypal_id: str, subject: str, note: str) -> None:
        self._request(
            "POST",
            f"/v2/invoicing/invoices/{paypal_id}/remind",
            json={"subject": subject[:4000], "note": note[:4000], "send_to_invoicer": False, "send_to_recipient": True},
        )

    def cancel(self, paypal_id: str, note: str = "") -> None:
        self._request(
            "POST",
            f"/v2/invoicing/invoices/{paypal_id}/cancel",
            json={"subject": "Payment request replaced", "note": note[:4000],
                  "send_to_invoicer": False, "send_to_recipient": False},
        )

    def record_payment(self, paypal_id: str, amount_cents: int, on: date, note: str = "") -> None:
        """Record money received outside PayPal, such as a bank transfer."""
        self._request(
            "POST",
            f"/v2/invoicing/invoices/{paypal_id}/payments",
            json={
                "method": "BANK_TRANSFER",
                "payment_date": on.isoformat(),
                "amount": {"currency_code": "EUR", "value": str(to_decimal(amount_cents))},
                "note": note[:2000],
            },
        )

    def find_by_number(self, number: str) -> str | None:
        response = self._request(
            "POST", "/v2/invoicing/search-invoices?page=1&page_size=1", json={"invoice_number": number}
        )
        items = response.json().get("items") or []
        return items[0]["id"] if items else None

    def verify_webhook(self, webhook_id: str, headers: dict[str, str], event: dict) -> bool:
        """Ask PayPal whether this webhook call really came from PayPal."""
        needed = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id",
                  "paypal-transmission-sig", "paypal-transmission-time"]
        if not webhook_id or any(not headers.get(name) for name in needed):
            return False
        try:
            response = self._request(
                "POST",
                "/v1/notifications/verify-webhook-signature",
                json={
                    "auth_algo": headers["paypal-auth-algo"],
                    "cert_url": headers["paypal-cert-url"],
                    "transmission_id": headers["paypal-transmission-id"],
                    "transmission_sig": headers["paypal-transmission-sig"],
                    "transmission_time": headers["paypal-transmission-time"],
                    "webhook_id": webhook_id,
                    "webhook_event": event,
                },
            )
        except PayPalError:
            return False
        return response.json().get("verification_status") == "SUCCESS"


@dataclass
class _SimInvoice:
    number: str
    gross_cents: int
    pay_link: str
    status: str = "DRAFT"
    paid_cents: int = 0
    transactions: list[dict] = field(default_factory=list)
    reminders: list[dict] = field(default_factory=list)


class SimulatedPayPal:
    """Behaves like the sandbox, but no network is used. It is shown clearly as simulated in the app."""

    simulated = True

    def __init__(self, store: Path | None = None) -> None:
        self._store = store
        self._invoices: dict[str, _SimInvoice] = {}
        self.fail_next: PayPalError | None = None
        self.calls: list[str] = []
        if store and store.exists():
            for key, value in json.loads(store.read_text(encoding="utf-8")).items():
                self._invoices[key] = _SimInvoice(**value)

    def _save(self) -> None:
        if self._store:
            self._store.parent.mkdir(parents=True, exist_ok=True)
            data = {key: vars(value) for key, value in self._invoices.items()}
            self._store.write_text(json.dumps(data), encoding="utf-8")

    def _maybe_fail(self, name: str) -> None:
        self.calls.append(name)
        if self.fail_next:
            error, self.fail_next = self.fail_next, None
            raise error

    def create_invoice(self, request: PaymentRequest) -> str:
        self._maybe_fail("create")
        for key, invoice in self._invoices.items():
            if invoice.number == request.number:
                return key  # the same result as the real client after a duplicate number
        gross = 0
        for line in request.lines:
            net = int(float(line.quantity) * line.unit_price_cents + 0.5)
            percent = float(line.vat_percent or 0)
            gross += net + int(net * percent / 100 + 0.5)
        key = f"SIM-{uuid.uuid4().hex[:12].upper()}"
        self._invoices[key] = _SimInvoice(request.number, gross, f"/simulated-paypal/{key}")
        self._save()
        return key

    def send(self, paypal_id: str, notify_customer: bool = True) -> None:
        self._maybe_fail("send")
        self._invoices[paypal_id].status = "SENT"
        self._save()

    def get(self, paypal_id: str) -> InvoiceState:
        self._maybe_fail("get")
        invoice = self._invoices.get(paypal_id)
        if invoice is None:
            raise PayPalError("Simulated invoice not found", status=404)
        return InvoiceState(
            paypal_id=paypal_id,
            status=invoice.status,
            paid_cents=invoice.paid_cents,
            due_cents=invoice.gross_cents - invoice.paid_cents,
            transactions=tuple(
                Transaction(t["id"], t["amount"], date.fromisoformat(t["on"]), t["method"]) for t in invoice.transactions
            ),
            pay_link=invoice.pay_link,
        )

    def qr_code(self, paypal_id: str) -> bytes | None:
        self._maybe_fail("qr")
        return None

    def remind(self, paypal_id: str, subject: str, note: str) -> None:
        self._maybe_fail("remind")
        self._invoices[paypal_id].reminders.append({"subject": subject, "note": note})
        self._save()

    def cancel(self, paypal_id: str, note: str = "") -> None:
        self._maybe_fail("cancel")
        self._invoices[paypal_id].status = "CANCELLED"
        self._save()

    def record_payment(self, paypal_id: str, amount_cents: int, on: date, note: str = "") -> None:
        self._maybe_fail("record_payment")
        self.pay(paypal_id, amount_cents, on)

    def find_by_number(self, number: str) -> str | None:
        return next((key for key, value in self._invoices.items() if value.number == number), None)

    def verify_webhook(self, webhook_id: str, headers: dict[str, str], event: dict) -> bool:
        return headers.get("x-simulated-signature") == "valid"

    # Only for the simulator: acts as the customer paying.
    def pay(self, paypal_id: str, amount_cents: int | None = None, on: date | None = None) -> None:
        invoice = self._invoices[paypal_id]
        amount = amount_cents if amount_cents is not None else invoice.gross_cents - invoice.paid_cents
        invoice.transactions.append(
            {"id": f"SIMPAY-{uuid.uuid4().hex[:10]}", "amount": amount,
             "on": (on or date.today()).isoformat(), "method": "PAYPAL"}
        )
        invoice.paid_cents += amount
        invoice.status = "PAID" if invoice.paid_cents >= invoice.gross_cents else "PARTIALLY_PAID"
        self._save()

    def reminders(self, paypal_id: str) -> list[dict]:
        return list(self._invoices[paypal_id].reminders)
