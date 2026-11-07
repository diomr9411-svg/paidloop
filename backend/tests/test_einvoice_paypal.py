from dataclasses import replace
from datetime import date
from io import BytesIO

import httpx
import pytest
from lxml import etree
from PIL import Image
from pypdf import PdfReader

from paidloop import einvoice
from paidloop.compliance import InvoiceFacts, Line, Party
from paidloop.paypal import PaymentRequest, PayPalClient, PayPalError, RequestLine, SimulatedPayPal, _parse_qr

FACTS = InvoiceFacts(
    seller=Party("Muster Elektro GmbH", "Beispielstraße 1", "32657", "Lemgo", email="a@example.com"),
    buyer=Party("Bäckerei Müller GmbH", "Musterweg 2", "32756", "Detmold", email="b@example.com"),
    seller_vat_id="DE123456789",
    seller_tax_number="",
    seller_small_business=False,
    buyer_is_business=True,
    issue_date=date(2026, 11, 7),
    service_date=date(2026, 11, 5),
    due_date=date(2026, 11, 21),
    property_work=False,
    lines=(Line("Badreparatur, Arbeitszeit", 4000, 6500, 1900, 26000), Line("Material", 1000, 12000, 1900, 12000)),
    vat_cents=7220,
    gross_cents=45220,
)
UNITS = ("HUR", "H87")
CII = {
    "rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
}


def test_valid_invoice_passes_official_rules():
    result = einvoice.create(FACTS, "RE-2026-0001", UNITS, [], "https://example.com/pay")
    assert result.rules_checked > 50
    assert einvoice.validate_rules(result.xml)[0] == []


def test_pdf_contains_the_same_xml_and_german_text():
    result = einvoice.create(FACTS, "RE-2026-0001", UNITS, ["Testhinweis"], "https://example.com/pay")
    assert einvoice.read_back_xml(result.pdf) == result.xml
    reader = PdfReader(BytesIO(result.pdf))
    text = reader.pages[0].extract_text()
    assert "Rechnung RE-2026-0001" in text
    assert "Bäckerei Müller GmbH" in text
    assert "Beispielstraße" in text
    assert "452,20 EUR" in text
    assert "Testhinweis" in text
    assert b"/OutputIntents" in result.pdf or "/OutputIntents" in reader.trailer["/Root"]


def test_totals_in_xml_are_correct():
    xml = etree.fromstring(einvoice.create(FACTS, "RE-1", UNITS, [], None).xml)
    get = lambda name: xml.findtext(f".//ram:{name}", namespaces=CII)
    assert get("GrandTotalAmount") == "452.20"
    assert get("TaxTotalAmount") == "72.20"
    assert get("DuePayableAmount") == "452.20"


def test_two_vat_rates_are_split():
    facts = replace(
        FACTS,
        lines=(Line("Arbeit", 1000, 10000, 1900, 10000), Line("Buch", 1000, 2000, 700, 2000)),
        vat_cents=2040,
        gross_cents=14040,
    )
    result = einvoice.create(facts, "RE-2", ("H87", "H87"), [], None)
    assert einvoice.validate_rules(result.xml)[0] == []
    text = PdfReader(BytesIO(result.pdf)).pages[0].extract_text()
    assert "USt. 19 %" in text and "USt. 7 %" in text


def test_small_business_invoice_passes_official_rules():
    facts = replace(
        FACTS,
        seller_small_business=True,
        seller_vat_id="",
        seller_tax_number="330/1234/5678",
        lines=(Line("Arbeit", 1000, 10000, 0, 10000),),
        vat_cents=0,
        gross_cents=10000,
    )
    result = einvoice.create(facts, "RE-3", ("H87",), ["Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."], None)
    assert einvoice.validate_rules(result.xml)[0] == []
    assert "E" in [e.text for e in etree.fromstring(result.xml).findall(".//ram:CategoryCode", CII)]


def test_rules_catch_wrong_totals():
    good = einvoice.build_xml(FACTS, "RE-4", UNITS, [], None)
    bad = good.replace(b">452.20<", b">999.99<")
    problems, _ = einvoice.validate_rules(bad)
    assert problems


def test_broken_data_never_produces_an_invoice():
    with pytest.raises(einvoice.EInvoiceInvalid):
        einvoice.create(replace(FACTS, gross_cents=1), "RE-5", UNITS, [], None)


def test_long_description_and_qr_code_fit():
    buffer = BytesIO()
    Image.new("RGBA", (100, 100), (0, 0, 0, 255)).save(buffer, "PNG")
    facts = replace(FACTS, lines=(Line("Sehr lange Beschreibung " * 12, 1500, 6500, 1900, 9750),),
                    vat_cents=1853, gross_cents=11603)
    result = einvoice.create(facts, "RE-6", ("HUR",), [], "https://example.com/" + "a" * 120, buffer.getvalue())
    assert len(PdfReader(BytesIO(result.pdf)).pages) == 1


# PayPal client against a fake server


def make_client(handler) -> PayPalClient:
    def router(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        return handler(request)

    http = httpx.Client(transport=httpx.MockTransport(router), base_url="https://api-m.sandbox.paypal.com")
    return PayPalClient("https://api-m.sandbox.paypal.com", "id", "secret", http=http)


REQUEST = PaymentRequest(
    number="RE-1", issue_date=date(2026, 11, 7), due_date=date(2026, 11, 21), note="Note",
    recipient_name="Kunde", recipient_email="k@example.com",
    lines=(RequestLine("Arbeit", "4", 6500, "19", hours=True),),
)


def test_create_invoice_sends_correct_body():
    seen = {}

    def handler(request):
        import json
        seen["body"] = json.loads(request.content)
        seen["request_id"] = request.headers.get("paypal-request-id")
        return httpx.Response(201, json={"id": "INV2-1"})

    assert make_client(handler).create_invoice(REQUEST) == "INV2-1"
    item = seen["body"]["items"][0]
    assert item["unit_amount"]["value"] == "65.00"
    assert item["unit_of_measure"] == "HOURS"
    assert item["tax"]["percent"] == "19"
    assert seen["body"]["detail"]["currency_code"] == "EUR"
    assert seen["request_id"]


def test_duplicate_number_finds_the_existing_invoice_instead_of_failing():
    def handler(request):
        if request.url.path == "/v2/invoicing/invoices":
            return httpx.Response(422, json={"details": [{"issue": "DUPLICATE_INVOICE_NUMBER"}]})
        return httpx.Response(200, json={"items": [{"id": "INV2-EXISTING"}]})

    assert make_client(handler).create_invoice(REQUEST) == "INV2-EXISTING"


def test_server_errors_are_retried_with_the_same_request_id(monkeypatch):
    monkeypatch.setattr("paidloop.paypal.time.sleep", lambda _: None)
    ids = []

    def handler(request):
        ids.append(request.headers.get("paypal-request-id"))
        if len(ids) < 3:
            return httpx.Response(503)
        return httpx.Response(204)

    make_client(handler).remind("INV2-1", "Subject", "Note")
    assert len(ids) == 3 and len(set(ids)) == 1


def test_errors_never_contain_keys():
    def handler(request):
        return httpx.Response(400, json={"message": "Bad", "details": [{"issue": "X", "description": "Nope"}]})

    with pytest.raises(PayPalError) as error:
        make_client(handler).send("INV2-1")
    assert error.value.issue == "X"
    assert "secret" not in str(error.value)


def test_expired_token_is_refreshed_once():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401) if len(calls) == 1 else httpx.Response(204)

    make_client(handler).send("INV2-1")
    assert len(calls) == 2


def test_state_is_parsed_from_real_paypal_shape():
    body = {
        "id": "INV2-1",
        "status": "PARTIALLY_PAID",
        "due_amount": {"currency_code": "EUR", "value": "352.20"},
        "detail": {"metadata": {"recipient_view_url": "https://www.sandbox.paypal.com/invoice/p/#INV2-1"}},
        "payments": {
            "paid_amount": {"currency_code": "EUR", "value": "100.00"},
            "transactions": [
                {"payment_id": "EXTR-1", "payment_date": "2026-11-07", "method": "BANK_TRANSFER",
                 "amount": {"currency_code": "EUR", "value": "100.00"}}
            ],
        },
    }
    state = make_client(lambda request: httpx.Response(200, json=body)).get("INV2-1")
    assert state.paid_cents == 10000 and state.due_cents == 35220
    assert state.transactions[0].external_id == "EXTR-1"
    assert state.transactions[0].paid_on == date(2026, 11, 7)
    assert state.pay_link.startswith("https://www.sandbox.paypal.com")


def test_qr_png_is_read_from_multipart_body():
    response = httpx.Response(
        200,
        headers={"content-type": "multipart/form-data; boundary=abc"},
        text='--abc\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgo=\r\n--abc--',
    )
    assert _parse_qr(response).startswith(b"\x89PNG")


def test_webhook_without_signature_headers_is_refused():
    client = make_client(lambda request: httpx.Response(200, json={"verification_status": "SUCCESS"}))
    assert client.verify_webhook("WH-1", {}, {"id": "1"}) is False
    assert client.verify_webhook("", {"paypal-auth-algo": "x"}, {"id": "1"}) is False


def test_simulator_matches_real_status_flow():
    sim = SimulatedPayPal()
    key = sim.create_invoice(REQUEST)
    assert sim.create_invoice(REQUEST) == key
    sim.send(key)
    assert sim.get(key).status == "SENT"
    assert sim.get(key).due_cents == 30940
    sim.pay(key, 10000)
    assert sim.get(key).status == "PARTIALLY_PAID"
    sim.pay(key)
    state = sim.get(key)
    assert state.status == "PAID" and state.due_cents == 0 and len(state.transactions) == 2
