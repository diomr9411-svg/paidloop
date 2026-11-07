// All text the customer sees. Amounts, dates and legal wording always come from code.
//
// The AI may only suggest one friendly sentence, and that sentence is screened (see safeAiSentence).
// German wording must be read by a German speaker before real use. Not legal advice.
import { germanDate, IsoDate } from "./dates";
import { LateCosts } from "./legal";
import { eur, eurDe } from "./money";
import * as policy from "./policy";

// Unicode-aware word edges: \b in JavaScript does not count ä, ö, ü as letters
const START = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";

const FORBIDDEN = new RegExp(
  `\\d|https?:|www\\.|€|rabatt|discount|erlass|erlassen|waive|storn|cancel|kostenlos|gratis|free|garant|` +
    `anwalt|lawyer|inkasso|gericht|court|klage|sue${END}|polizei|police|schufa|versprech|promise`,
  "iu",
);
const GERMAN_HINT = new RegExp(
  `${START}(ich|nicht|kann|bitte|danke|rechnung|zahlen|bezahlt|habe|und|der|die|das|mehr|zeit|raten|guten|hallo|sie|ihre?n?|wir|verstehe|dass)${END}`,
  "iu",
);
const LATIN_ONLY = /^[\sA-Za-zÀ-ÿ.,;:!?'"()\-–]+$/;
const GREETING = new RegExp(`^(guten\\s+tag|hallo|hello|hi${END}|dear|sehr\\s+geehrte)`, "iu");

export const looksGerman = (text: string): boolean => GERMAN_HINT.test(text);

/**
 * Return the AI's sentence only if it has no numbers, links, promises or threats.
 * Small models sometimes answer in the wrong language or mix alphabets, so that is checked too.
 */
export function safeAiSentence(text: string | null | undefined, language?: string | null): string {
  if (!text) return "";
  const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
  if (cleaned.length < 3 || cleaned.length > 220 || FORBIDDEN.test(cleaned) || !LATIN_ONLY.test(cleaned)) return "";
  if (language && looksGerman(cleaned) !== (language === "de")) return "";
  if (GREETING.test(cleaned)) return ""; // the message already has a greeting
  return cleaned;
}

export interface Reminder {
  subject: string;
  body: string;
  english_for_owner: string;
  german_for_owner: string;
}

const rate = (costs: LateCosts): string => costs.rate_percent.toFixed(2);

export function reminder(
  action: string,
  language: string,
  customerName: string,
  number: string,
  openCents: number,
  dueDate: IsoDate,
  payPage: string,
  sellerName: string,
  costs: LateCosts | null = null,
  aiSentence = "",
): Reminder {
  // The AI's sentence is in the customer's language, so it only goes in that version.
  const english = reminderEn(action, customerName, number, openCents, dueDate, payPage, sellerName, costs, language !== "de" ? aiSentence : "");
  const german = reminderDe(action, customerName, number, openCents, dueDate, payPage, sellerName, costs, language === "de" ? aiSentence : "");
  const chosen = language === "de" ? german : english;
  return { subject: chosen[0], body: chosen[1], english_for_owner: english[1], german_for_owner: german[1] };
}

function reminderDe(action: string, name: string, number: string, openCents: number, due: IsoDate, page: string, seller: string, costs: LateCosts | null, sentence: string): [string, string] {
  const opening = sentence ? `${sentence}\n\n` : "";
  const helpLine = `Wenn es gerade schwierig ist, schreiben Sie uns einfach. Wir finden gemeinsam eine Lösung: ${page}`;
  const greeting = `Guten Tag ${name},\n\n${opening}`;
  const closing = `\n\nMit freundlichen Grüßen\n${seller}`;
  const amount = eurDe(openCents);
  if (action === policy.PRE_DUE) {
    return [`Kurze Erinnerung: Rechnung ${number}`,
      `${greeting}Ihre Rechnung ${number} über ${amount} ist am ${germanDate(due)} fällig. ` +
      `Falls Sie schon bezahlt haben, ist alles in Ordnung.\n\n${helpLine}${closing}`];
  }
  if (action === policy.FRIENDLY) {
    return [`Zahlungserinnerung: Rechnung ${number}`,
      `${greeting}vielleicht ist es untergegangen: Ihre Rechnung ${number} über ${amount} war am ${germanDate(due)} fällig. ` +
      `Bitte überweisen Sie den Betrag in den nächsten Tagen.\n\n${helpLine}${closing}`];
  }
  if (action === policy.FIRM) {
    return [`Mahnung: Rechnung ${number}`,
      `${greeting}Ihre Rechnung ${number} über ${amount} war am ${germanDate(due)} fällig und ist noch offen. ` +
      `Wir bitten Sie hiermit, den Betrag innerhalb von 7 Tagen zu bezahlen.\n\n${helpLine}${closing}`];
  }
  let late = "";
  if (costs && costs.in_default) {
    late = ` Seit dem ${germanDate(costs.default_since!)} befinden Sie sich in Zahlungsverzug. ` +
      `Wir können Verzugszinsen von ${rate(costs)} % pro Jahr verlangen (bisher ${eurDe(costs.interest_cents)})`;
    late += costs.flat_fee_cents ? ` sowie eine Pauschale von ${eurDe(costs.flat_fee_cents)}.` : ".";
  }
  return [`Letzte Mahnung: Rechnung ${number}`,
    `${greeting}Ihre Rechnung ${number} über ${amount} ist seit dem ${germanDate(due)} offen.${late} ` +
    `Bitte bezahlen Sie innerhalb von 7 Tagen.\n\n${helpLine}${closing}`];
}

function reminderEn(action: string, name: string, number: string, openCents: number, due: IsoDate, page: string, seller: string, costs: LateCosts | null, sentence: string): [string, string] {
  const opening = sentence ? `${sentence}\n\n` : "";
  const helpLine = `If this is difficult right now, just write to us. We will find a solution together: ${page}`;
  const greeting = `Hello ${name},\n\n${opening}`;
  const closing = `\n\nKind regards\n${seller}`;
  const amount = eur(openCents);
  if (action === policy.PRE_DUE) {
    return [`Short reminder: invoice ${number}`,
      `${greeting}Your invoice ${number} for ${amount} is due on ${germanDate(due)}. ` +
      `If you have already paid, everything is fine.\n\n${helpLine}${closing}`];
  }
  if (action === policy.FRIENDLY) {
    return [`Payment reminder: invoice ${number}`,
      `${greeting}Perhaps this was missed: your invoice ${number} for ${amount} was due on ${germanDate(due)}. ` +
      `Please pay the amount in the next few days.\n\n${helpLine}${closing}`];
  }
  if (action === policy.FIRM) {
    return [`Formal reminder: invoice ${number}`,
      `${greeting}Your invoice ${number} for ${amount} was due on ${germanDate(due)} and is still open. ` +
      `Please pay the amount within 7 days.\n\n${helpLine}${closing}`];
  }
  let late = "";
  if (costs && costs.in_default) {
    late = ` You have been in default since ${germanDate(costs.default_since!)}. We can charge default interest of ` +
      `${rate(costs)}% per year (${eur(costs.interest_cents)} so far)`;
    late += costs.flat_fee_cents ? ` and a flat fee of ${eur(costs.flat_fee_cents)}.` : ".";
  }
  return [`Final reminder: invoice ${number}`,
    `${greeting}Your invoice ${number} for ${amount} has been open since ${germanDate(due)}.${late} ` +
    `Please pay within 7 days.\n\n${helpLine}${closing}`];
}

// Chat replies

const CHAT: Record<string, { de: string; en: string }> = {
  welcome: {
    de: "Guten Tag! Wenn Sie gerade nicht alles bezahlen können oder etwas an der Rechnung nicht stimmt, schreiben Sie es mir einfach.",
    en: "Hello! If you can't pay it all right now, or something about the invoice is wrong, just tell me.",
  },
  offer: {
    de: 'Das verstehe ich. Ich kann Ihnen diese Raten anbieten:\n{plan}\nWenn das für Sie passt, klicken Sie auf "Plan annehmen".',
    en: 'I understand. I can offer you this plan:\n{plan}\nIf this works for you, click "Accept plan".',
  },
  offer_adjusted: {
    de: 'Das verstehe ich. Genau so kann ich es nicht anbieten, aber das ist der nächste mögliche Plan:\n{plan}\nWenn das passt, klicken Sie auf "Plan annehmen". Sonst frage ich gern die Geschäftsleitung.',
    en: 'I understand. I can\'t offer exactly that, but this is the closest plan I can offer:\n{plan}\nIf this works, click "Accept plan". If not, I can ask the owner.',
  },
  no_plan: {
    de: "Für diesen Betrag kann ich selbst keinen Plan anbieten. Ich habe die Geschäftsleitung informiert. Sie erhalten eine Antwort.",
    en: "I can't offer a plan myself for this amount. I have told the owner, who will contact you.",
  },
  asked_owner: {
    de: "Ich habe Ihre Anfrage an die Geschäftsleitung weitergegeben. Sie erhalten eine persönliche Antwort.",
    en: "I have passed your request to the owner, who will decide personally and contact you.",
  },
  dispute: {
    de: "Danke, dass Sie das sagen. Ich habe die Erinnerungen zu dieser Rechnung angehalten und die Geschäftsleitung informiert. Sie erhalten eine Antwort.",
    en: "Thank you for telling me. I have paused reminders for this invoice and told the owner, who will contact you.",
  },
  paid_found: {
    de: "Ihre Zahlung ist bei uns eingegangen. Vielen Dank!",
    en: "Your payment has arrived. Thank you!",
  },
  paid_not_found: {
    de: "Ich sehe noch keine Zahlung, aber das kann ein paar Tage dauern. Ich halte die Erinnerungen {days} Tage an. Falls Sie einen Beleg haben, schicken Sie ihn bitte an uns.",
    en: "I can't see a payment yet, but this can take a few days. I have paused reminders for {days} days. If you have a receipt, please send it to the owner.",
  },
  paid_not_found_again: {
    de: "Ich sehe weiterhin keine Zahlung. Ich habe die Geschäftsleitung gebeten, das zu prüfen.",
    en: "I still can't see a payment. I have asked the owner to check this.",
  },
  not_allowed: {
    de: "Das kann ich nicht ändern. Über Rabatte, Stornierungen und Erlasse entscheidet nur die Geschäftsleitung. Ich kann Ihnen aber eine Ratenzahlung anbieten, wenn das hilft.",
    en: "I can't change that. Only the owner can decide on discounts, cancellations or waivers. I can offer you a payment plan if that helps.",
  },
  question: {
    de: "Offen sind {amount}. Sie können mit dem PayPal-Knopf oben bezahlen. Wenn Sie Raten brauchen oder etwas nicht stimmt, sagen Sie es mir.",
    en: "The open amount is {amount}. You can pay with the PayPal button above. If you need a payment plan or something is wrong, tell me.",
  },
  accepted: {
    de: "Danke! Ihr Plan ist aktiv. Die erste Zahlung über {amount} ist bis {date} fällig. Die Zahlungslinks finden Sie oben.",
    en: "Thank you! Your plan is active. The first payment of {amount} is due by {date}. The payment links are above.",
  },
};

export function chat(key: string, language: string, values: Record<string, string | number> = {}): string {
  const lang = language === "de" || language === "en" ? language : "de";
  return CHAT[key][lang].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

export function planLines(payments: [amountCents: number, due: IsoDate][], language: string): string {
  const money = language === "de" ? eurDe : eur;
  return payments.map(([amount, due], index) => `${index + 1}. ${money(amount)} (${germanDate(due)})`).join("\n");
}
