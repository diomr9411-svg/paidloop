// Checks an invoice against German rules. Fixed code with tests, never AI. Not tax or legal advice.
//
// Sources: Sec. 14(4) UStG (required fields), Sec. 19 UStG (small business), Sec. 33 UStDV (small
// invoices up to 250 EUR gross), Sec. 14b(1) UStG (keeping invoices for work on property), Sec. 286(3)
// BGB (consumer notice). Every message exists in English and German.
import { IsoDate } from "./dates";
import { t, Text } from "./i18n";
import { lineNet, percentOf } from "./money";

export const ERROR = "error"; // blocks issuing
export const WARNING = "warning"; // issuing is allowed, the owner should look
export const INFO = "info";

export const SMALL_INVOICE_LIMIT_CENTS = 25000;
export const ALLOWED_VAT_BP = new Set([1900, 700]);

export const CONSUMER_NOTICE_DE =
  "Hinweis: Sie kommen spätestens 30 Tage nach Fälligkeit und Zugang dieser Rechnung in Verzug, " +
  "wenn Sie nicht zahlen (§ 286 Abs. 3 BGB).";
export const CONSUMER_NOTICE_EN =
  "Note: you will be in default at the latest 30 days after the due date and receipt of this invoice " +
  "if you do not pay (Sec. 286(3) German Civil Code).";
export const SMALL_BUSINESS_NOTE_DE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";
export const SMALL_BUSINESS_NOTE_EN = "No VAT is charged under Sec. 19 of the German VAT Act (small business).";
export const RETENTION_NOTE_DE = "Bitte bewahren Sie diese Rechnung zwei Jahre auf (§ 14b Abs. 1 Satz 5 UStG).";
export const RETENTION_NOTE_EN = "Please keep this invoice for two years (Sec. 14b(1) sentence 5 of the German VAT Act).";

export interface Party {
  name: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
}

export const party = (values: Partial<Party> = {}): Party => ({ name: "", street: "", postcode: "", city: "", country: "DE", email: "", ...values });

export const hasFullAddress = (p: Party): boolean => Boolean(p.name.trim() && p.street.trim() && p.postcode.trim() && p.city.trim());

export interface Line {
  description: string;
  quantity_milli: number;
  unit_price_cents: number;
  vat_bp: number;
  net_cents: number;
}

export interface InvoiceFacts {
  seller: Party;
  buyer: Party;
  seller_vat_id: string;
  seller_tax_number: string;
  seller_small_business: boolean;
  buyer_is_business: boolean;
  issue_date: IsoDate | null;
  service_date: IsoDate | null;
  due_date: IsoDate | null;
  property_work: boolean;
  lines: Line[];
  vat_cents: number;
  gross_cents: number;
  buyer_language: string;
}

export interface Issue {
  rule_id: string;
  severity: string;
  field: string;
  law: string;
  message: Text;
  fix: Text;
}

export interface CheckResult {
  issues: Issue[];
  notes_to_print: string[];
  can_issue: boolean;
}

/** Sec. 14(4) no. 5 UStG becomes § 14 Abs. 4 Nr. 5 UStG, as German readers expect. */
export function lawInGerman(law: string): string {
  const text = law
    .replace(/Sec\. (\d+\w*)\((\d+)\)/g, "§ $1 Abs. $2")
    .replaceAll("Sec. ", "§ ")
    .replaceAll(" no. ", " Nr. ")
    .replaceAll(" sentence ", " Satz ")
    .replaceAll(" and ", " und ");
  return text === "PayPal invoicing" ? "PayPal-Rechnungen" : text;
}

/** Per VAT rate: [net total, VAT]. VAT is worked out per rate, as EN 16931 requires. */
export function vatGroups(lines: readonly Line[]): Map<number, [net: number, vat: number]> {
  const nets = new Map<number, number>();
  for (const line of lines) nets.set(line.vat_bp, (nets.get(line.vat_bp) ?? 0) + line.net_cents);
  return new Map([...nets].map(([bp, net]) => [bp, [net, percentOf(net, bp)] as [number, number]]));
}

export function check(facts: InvoiceFacts): CheckResult {
  const issues: Issue[] = [];
  const notes: string[] = [];
  const add = (rule_id: string, severity: string, field: string, law: string, message: Text, fix: Text): void => {
    issues.push({ rule_id, severity, field, law, message, fix });
  };
  const netTotal = facts.lines.reduce((sum, line) => sum + line.net_cents, 0);
  const smallInvoice = facts.gross_cents > 0 && facts.gross_cents <= SMALL_INVOICE_LIMIT_CENTS;
  const german = facts.buyer_language !== "en";

  if (!hasFullAddress(facts.seller)) {
    add("R-14-1-SELLER", ERROR, "seller", "Sec. 14(4) no. 1 UStG",
      t("Your full name and address are missing.", "Ihr vollständiger Name und Ihre Anschrift fehlen."),
      t("Add them in your business settings.", "Tragen Sie beides in den Einstellungen ein."));
  }

  if (!facts.buyer.name.trim()) {
    add("R-14-1-BUYER", ERROR, "buyer.name", "Sec. 14(4) no. 1 UStG",
      t("The customer's name is missing.", "Der Name des Kunden fehlt."),
      t("Add the customer's full name.", "Tragen Sie den vollständigen Namen ein."));
  } else if (!hasFullAddress(facts.buyer)) {
    if (smallInvoice) {
      add("R-33-BUYER", INFO, "buyer.address", "Sec. 33 UStDV",
        t("Invoices up to 250 EUR gross can leave out the customer's address.",
          "Rechnungen bis 250 EUR brutto dürfen ohne Kundenanschrift ausgestellt werden."),
        t("You can still add it, as this helps with reminders.", "Sie können sie trotzdem eintragen, das hilft bei Erinnerungen."));
    } else {
      add("R-14-1-BUYER-ADDRESS", ERROR, "buyer.address", "Sec. 14(4) no. 1 UStG",
        t("The customer's full address is missing.", "Die vollständige Anschrift des Kunden fehlt."),
        t("Add street, postcode and city.", "Tragen Sie Straße, PLZ und Ort ein."));
    }
  }

  if (!(facts.seller_vat_id.trim() || facts.seller_tax_number.trim()) && !smallInvoice) {
    add("R-14-2-TAX-ID", ERROR, "seller.tax", "Sec. 14(4) no. 2 UStG",
      t("Your tax number or VAT ID is missing.", "Ihre Steuernummer oder USt-IdNr. fehlt."),
      t("Add one in your business settings.", "Tragen Sie eine davon in den Einstellungen ein."));
  }

  if (facts.issue_date === null) {
    add("R-14-3-DATE", ERROR, "issue_date", "Sec. 14(4) no. 3 UStG",
      t("The issue date is missing.", "Das Rechnungsdatum fehlt."),
      t("Set the invoice date.", "Legen Sie das Rechnungsdatum fest."));
  }

  if (!facts.lines.length) {
    add("R-14-5-LINES", ERROR, "lines", "Sec. 14(4) no. 5 UStG",
      t("The invoice has no items.", "Die Rechnung hat keine Positionen."),
      t("Add at least one item.", "Fügen Sie mindestens eine Position hinzu."));
  }

  facts.lines.forEach((line, index) => {
    const position = index + 1;
    if (!line.description.trim()) {
      add("R-14-5-DESC", ERROR, `lines.${position}.description`, "Sec. 14(4) no. 5 UStG",
        t(`Item ${position} does not say what was delivered or done.`, `Position ${position} nennt nicht, was geliefert oder geleistet wurde.`),
        t("Describe the work or goods.", "Beschreiben Sie die Arbeit oder Ware."));
    }
    if (line.quantity_milli <= 0) {
      add("R-14-5-QTY", ERROR, `lines.${position}.quantity`, "Sec. 14(4) no. 5 UStG",
        t(`Item ${position} has no quantity.`, `Position ${position} hat keine Menge.`),
        t("Enter a quantity above zero.", "Tragen Sie eine Menge über null ein."));
    }
    if (line.unit_price_cents <= 0) {
      add("R-PRICE", ERROR, `lines.${position}.price`, "Sec. 14(4) no. 7 UStG",
        t(`Item ${position} has no price.`, `Position ${position} hat keinen Preis.`),
        t("Enter a price above zero.", "Tragen Sie einen Preis über null ein."));
    }
    if (line.net_cents !== lineNet(line.quantity_milli, line.unit_price_cents)) {
      add("R-MATH-LINE", ERROR, `lines.${position}.net`, "Sec. 14(4) no. 7 UStG",
        t(`Item ${position}: quantity times price does not match its total.`, `Position ${position}: Menge mal Preis passt nicht zur Summe.`),
        t("Recalculate this item.", "Berechnen Sie diese Position neu."));
    }
  });

  if (facts.service_date === null && !smallInvoice) {
    add("R-14-6-SERVICE-DATE", ERROR, "service_date", "Sec. 14(4) no. 6 UStG",
      t("The date of the work or delivery is missing.", "Das Leistungsdatum fehlt."),
      t("Enter when the work was done.", "Tragen Sie ein, wann die Arbeit erledigt wurde."));
  }

  if (facts.seller_small_business) {
    if (facts.vat_cents !== 0 || facts.lines.some((line) => line.vat_bp !== 0)) {
      add("R-19-NO-VAT", ERROR, "vat", "Sec. 19 UStG, Sec. 14c UStG",
        t("As a small business you must not show VAT. VAT shown by mistake can still be owed.",
          "Als Kleinunternehmer dürfen Sie keine Umsatzsteuer ausweisen. Falsch ausgewiesene Steuer kann trotzdem geschuldet sein."),
        t("Set VAT to 0% on all items.", "Setzen Sie die Umsatzsteuer bei allen Positionen auf 0 %."));
    }
    notes.push(german ? SMALL_BUSINESS_NOTE_DE : SMALL_BUSINESS_NOTE_EN);
  } else {
    facts.lines.forEach((line, index) => {
      if (!ALLOWED_VAT_BP.has(line.vat_bp)) {
        const position = index + 1;
        add("R-14-8-RATE", ERROR, `lines.${position}.vat`, "Sec. 14(4) no. 8 UStG",
          t(`Item ${position}: only 19% and 7% are supported here.`, `Position ${position}: Hier werden nur 19 % und 7 % unterstützt.`),
          t("Choose 19% or 7%. Ask a tax adviser about exempt sales.", "Wählen Sie 19 % oder 7 %. Fragen Sie bei steuerfreien Umsätzen Ihre Steuerberatung."));
      }
    });
    const vatSum = [...vatGroups(facts.lines).values()].reduce((sum, [, vat]) => sum + vat, 0);
    if (facts.vat_cents !== vatSum) {
      add("R-MATH-VAT", ERROR, "vat", "Sec. 14(4) no. 8 UStG",
        t("The VAT total does not match the items.", "Die Umsatzsteuer passt nicht zu den Positionen."),
        t("Recalculate the invoice.", "Berechnen Sie die Rechnung neu."));
    }
  }

  if (facts.gross_cents !== netTotal + facts.vat_cents) {
    add("R-MATH-TOTAL", ERROR, "gross", "Sec. 14(4) no. 7 and 8 UStG",
      t("Net plus VAT does not equal the total.", "Netto plus Umsatzsteuer ergibt nicht die Summe."),
      t("Recalculate the invoice.", "Berechnen Sie die Rechnung neu."));
  }

  if (facts.due_date === null) {
    add("R-DUE", ERROR, "due_date", "Sec. 286 BGB",
      t("There is no payment date, so reminders cannot be timed.", "Es gibt kein Zahlungsziel, daher lassen sich Erinnerungen nicht planen."),
      t("Set a due date.", "Legen Sie ein Fälligkeitsdatum fest."));
  } else if (facts.issue_date && facts.due_date < facts.issue_date) {
    add("R-DUE-ORDER", ERROR, "due_date", "Sec. 286 BGB",
      t("The due date is before the invoice date.", "Das Fälligkeitsdatum liegt vor dem Rechnungsdatum."),
      t("Correct the due date.", "Korrigieren Sie das Fälligkeitsdatum."));
  }

  if (!facts.buyer.email.trim()) {
    add("R-EMAIL", ERROR, "buyer.email", "PayPal invoicing",
      t("The customer's email is missing, so PayPal cannot link the payment request.",
        "Die E-Mail des Kunden fehlt, daher kann PayPal die Zahlungsaufforderung nicht zuordnen."),
      t("Add the customer's email.", "Tragen Sie die E-Mail des Kunden ein."));
  }

  if (!facts.buyer_is_business) {
    notes.push(german ? CONSUMER_NOTICE_DE : CONSUMER_NOTICE_EN);
    add("R-286-NOTICE", INFO, "notes", "Sec. 286(3) BGB",
      t("Your customer is a consumer. The 30-day late payment rule only applies if the invoice says so.",
        "Ihr Kunde ist Verbraucher. Die 30-Tage-Regel gilt nur, wenn die Rechnung darauf hinweist."),
      t("Added automatically.", "Wurde automatisch ergänzt."));
    if (facts.property_work) {
      notes.push(german ? RETENTION_NOTE_DE : RETENTION_NOTE_EN);
      add("R-14-9-RETENTION", INFO, "notes", "Sec. 14(4) no. 9 and Sec. 14b(1) UStG",
        t("Private customers must keep invoices for work on a building for two years, and the invoice has to tell them.",
          "Privatkunden müssen Rechnungen für Arbeiten am Gebäude zwei Jahre aufbewahren, und die Rechnung muss darauf hinweisen."),
        t("Added automatically.", "Wurde automatisch ergänzt."));
    }
  } else if (!facts.seller_small_business && !smallInvoice) {
    add("R-EINVOICE", INFO, "format", "Sec. 14 UStG, Sec. 27(38) UStG",
      t("Business customers in Germany must be able to receive e-invoices. Sending them becomes " +
        "mandatory from 2027 (over 800,000 EUR turnover) or 2028.",
        "Geschäftskunden in Deutschland müssen E-Rechnungen empfangen können. Der Versand wird ab 2027 " +
        "(über 800.000 EUR Umsatz) oder 2028 Pflicht."),
      t("PaidLoop creates a ZUGFeRD e-invoice for you.", "PaidLoop erstellt für Sie eine ZUGFeRD-E-Rechnung."));
  }

  return { issues, notes_to_print: notes, can_issue: !issues.some((issue) => issue.severity === ERROR) };
}
