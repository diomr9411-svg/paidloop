"""All text the customer sees. Amounts, dates and legal wording always come from code.

The AI may only suggest one friendly sentence, and that sentence is screened (see safe_ai_sentence).
German wording must be read by a German speaker before real use. Not legal advice.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from paidloop import policy
from paidloop.legal import LateCosts
from paidloop.money import eur, eur_de

FORBIDDEN = re.compile(
    r"\d|https?:|www\.|€|rabatt|discount|erlass|erlassen|waive|storn|cancel|kostenlos|gratis|free|garant|"
    r"anwalt|lawyer|inkasso|gericht|court|klage|sue\b|polizei|police|schufa|versprech|promise",
    re.IGNORECASE,
)


GERMAN_HINT = re.compile(
    r"\b(ich|nicht|kann|bitte|danke|rechnung|zahlen|bezahlt|habe|und|der|die|das|mehr|zeit|raten|guten|hallo|sie|ihre?n?|wir|verstehe|dass)\b",
    re.IGNORECASE,
)
LATIN_ONLY = re.compile(r"^[\sA-Za-zÀ-ÿ.,;:!?'\"()\-–]+$")


def looks_german(text: str) -> bool:
    return bool(GERMAN_HINT.search(text))


def safe_ai_sentence(text: str | None, language: str | None = None) -> str:
    """Return the AI's sentence only if it has no numbers, links, promises or threats.

    Small models sometimes answer in the wrong language or mix alphabets, so that is checked too.
    """
    if not text:
        return ""
    cleaned = " ".join(text.split())
    if not 3 <= len(cleaned) <= 220 or FORBIDDEN.search(cleaned) or not LATIN_ONLY.match(cleaned):
        return ""
    if language and looks_german(cleaned) != (language == "de"):
        return ""
    if re.match(r"(guten\s+tag|hallo|hello|hi\b|dear|sehr\s+geehrte)", cleaned, re.IGNORECASE):
        return ""  # the message already has a greeting
    return cleaned


@dataclass(frozen=True)
class Reminder:
    subject: str
    body: str
    english_for_owner: str


def _d(day: date) -> str:
    return f"{day:%d.%m.%Y}"


def reminder(
    action: str,
    language: str,
    customer_name: str,
    number: str,
    open_cents: int,
    due_date: date,
    pay_page: str,
    seller_name: str,
    costs: LateCosts | None = None,
    ai_sentence: str = "",
) -> Reminder:
    english = _reminder_en(action, customer_name, number, open_cents, due_date, pay_page, seller_name, costs, ai_sentence)
    if language != "de":
        return Reminder(english[0], english[1], english[1])
    german = _reminder_de(action, customer_name, number, open_cents, due_date, pay_page, seller_name, costs, ai_sentence)
    return Reminder(german[0], german[1], english[1])


def _reminder_de(action, name, number, open_cents, due, page, seller, costs, sentence) -> tuple[str, str]:
    opening = f"{sentence}\n\n" if sentence else ""
    help_line = f"Wenn es gerade schwierig ist, schreiben Sie uns einfach. Wir finden gemeinsam eine Lösung: {page}"
    greeting = f"Guten Tag {name},\n\n{opening}"
    closing = f"\n\nMit freundlichen Grüßen\n{seller}"
    amount = eur_de(open_cents)
    if action == policy.PRE_DUE:
        return (f"Kurze Erinnerung: Rechnung {number}",
                f"{greeting}Ihre Rechnung {number} über {amount} ist am {_d(due)} fällig. "
                f"Falls Sie schon bezahlt haben, ist alles in Ordnung.\n\n{help_line}{closing}")
    if action == policy.FRIENDLY:
        return (f"Zahlungserinnerung: Rechnung {number}",
                f"{greeting}vielleicht ist es untergegangen: Ihre Rechnung {number} über {amount} war am {_d(due)} fällig. "
                f"Bitte überweisen Sie den Betrag in den nächsten Tagen.\n\n{help_line}{closing}")
    if action == policy.FIRM:
        return (f"Mahnung: Rechnung {number}",
                f"{greeting}Ihre Rechnung {number} über {amount} war am {_d(due)} fällig und ist noch offen. "
                f"Wir bitten Sie hiermit, den Betrag innerhalb von 7 Tagen zu bezahlen.\n\n{help_line}{closing}")
    late = ""
    if costs and costs.in_default:
        late = (f" Seit dem {_d(costs.default_since)} befinden Sie sich in Zahlungsverzug. "
                f"Wir können Verzugszinsen von {costs.rate_percent} % pro Jahr verlangen (bisher {eur_de(costs.interest_cents)})")
        late += f" sowie eine Pauschale von {eur_de(costs.flat_fee_cents)}." if costs.flat_fee_cents else "."
    return (f"Letzte Mahnung: Rechnung {number}",
            f"{greeting}Ihre Rechnung {number} über {amount} ist seit dem {_d(due)} offen.{late} "
            f"Bitte bezahlen Sie innerhalb von 7 Tagen.\n\n{help_line}{closing}")


def _reminder_en(action, name, number, open_cents, due, page, seller, costs, sentence) -> tuple[str, str]:
    opening = f"{sentence}\n\n" if sentence else ""
    help_line = f"If this is difficult right now, just write to us. We will find a solution together: {page}"
    greeting = f"Hello {name},\n\n{opening}"
    closing = f"\n\nKind regards\n{seller}"
    amount = eur(open_cents)
    if action == policy.PRE_DUE:
        return (f"Short reminder: invoice {number}",
                f"{greeting}Your invoice {number} for {amount} is due on {_d(due)}. "
                f"If you have already paid, everything is fine.\n\n{help_line}{closing}")
    if action == policy.FRIENDLY:
        return (f"Payment reminder: invoice {number}",
                f"{greeting}Perhaps this was missed: your invoice {number} for {amount} was due on {_d(due)}. "
                f"Please pay the amount in the next few days.\n\n{help_line}{closing}")
    if action == policy.FIRM:
        return (f"Formal reminder: invoice {number}",
                f"{greeting}Your invoice {number} for {amount} was due on {_d(due)} and is still open. "
                f"Please pay the amount within 7 days.\n\n{help_line}{closing}")
    late = ""
    if costs and costs.in_default:
        late = (f" You have been in default since {_d(costs.default_since)}. We can charge default interest of "
                f"{costs.rate_percent}% per year ({eur(costs.interest_cents)} so far)")
        late += f" and a flat fee of {eur(costs.flat_fee_cents)}." if costs.flat_fee_cents else "."
    return (f"Final reminder: invoice {number}",
            f"{greeting}Your invoice {number} for {amount} has been open since {_d(due)}.{late} "
            f"Please pay within 7 days.\n\n{help_line}{closing}")


# Chat replies

CHAT = {
    "welcome": {
        "de": "Guten Tag! Wenn Sie gerade nicht alles bezahlen können oder etwas an der Rechnung nicht stimmt, schreiben Sie es mir einfach.",
        "en": "Hello! If you can't pay it all right now, or something about the invoice is wrong, just tell me.",
    },
    "offer": {
        "de": "Das verstehe ich. Ich kann Ihnen diese Raten anbieten:\n{plan}\nWenn das für Sie passt, klicken Sie auf \"Plan annehmen\".",
        "en": "I understand. I can offer you this plan:\n{plan}\nIf this works for you, click \"Accept plan\".",
    },
    "offer_adjusted": {
        "de": "Das verstehe ich. Genau so kann ich es nicht anbieten, aber das ist der nächste mögliche Plan:\n{plan}\nWenn das passt, klicken Sie auf \"Plan annehmen\". Sonst frage ich gern die Geschäftsleitung.",
        "en": "I understand. I can't offer exactly that, but this is the closest plan I can offer:\n{plan}\nIf this works, click \"Accept plan\". If not, I can ask the owner.",
    },
    "no_plan": {
        "de": "Für diesen Betrag kann ich selbst keinen Plan anbieten. Ich habe die Geschäftsleitung informiert. Sie erhalten eine Antwort.",
        "en": "I can't offer a plan myself for this amount. I have told the owner, who will contact you.",
    },
    "asked_owner": {
        "de": "Ich habe Ihre Anfrage an die Geschäftsleitung weitergegeben. Sie erhalten eine persönliche Antwort.",
        "en": "I have passed your request to the owner, who will decide personally and contact you.",
    },
    "dispute": {
        "de": "Danke, dass Sie das sagen. Ich habe die Erinnerungen zu dieser Rechnung angehalten und die Geschäftsleitung informiert. Sie erhalten eine Antwort.",
        "en": "Thank you for telling me. I have paused reminders for this invoice and told the owner, who will contact you.",
    },
    "paid_found": {
        "de": "Ihre Zahlung ist bei uns eingegangen. Vielen Dank!",
        "en": "Your payment has arrived. Thank you!",
    },
    "paid_not_found": {
        "de": "Ich sehe noch keine Zahlung, aber das kann ein paar Tage dauern. Ich halte die Erinnerungen {days} Tage an. Falls Sie einen Beleg haben, schicken Sie ihn bitte an uns.",
        "en": "I can't see a payment yet, but this can take a few days. I have paused reminders for {days} days. If you have a receipt, please send it to the owner.",
    },
    "paid_not_found_again": {
        "de": "Ich sehe weiterhin keine Zahlung. Ich habe die Geschäftsleitung gebeten, das zu prüfen.",
        "en": "I still can't see a payment. I have asked the owner to check this.",
    },
    "not_allowed": {
        "de": "Das kann ich nicht ändern. Über Rabatte, Stornierungen und Erlasse entscheidet nur die Geschäftsleitung. Ich kann Ihnen aber eine Ratenzahlung anbieten, wenn das hilft.",
        "en": "I can't change that. Only the owner can decide on discounts, cancellations or waivers. I can offer you a payment plan if that helps.",
    },
    "question": {
        "de": "Offen sind {amount}. Sie können mit dem PayPal-Knopf oben bezahlen. Wenn Sie Raten brauchen oder etwas nicht stimmt, sagen Sie es mir.",
        "en": "The open amount is {amount}. You can pay with the PayPal button above. If you need a payment plan or something is wrong, tell me.",
    },
    "accepted": {
        "de": "Danke! Ihr Plan ist aktiv. Die erste Zahlung über {amount} ist bis {date} fällig. Die Zahlungslinks finden Sie oben.",
        "en": "Thank you! Your plan is active. The first payment of {amount} is due by {date}. The payment links are above.",
    },
}


def chat(key: str, language: str, **values: str) -> str:
    language = language if language in {"de", "en"} else "de"
    return CHAT[key][language].format(**values)


def plan_lines(payments: list[tuple[int, date]], language: str) -> str:
    money = eur_de if language == "de" else eur
    return "\n".join(f"{index}. {money(amount)} ({_d(due)})" for index, (amount, due) in enumerate(payments, start=1))
