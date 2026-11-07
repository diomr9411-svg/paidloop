// Creates the legal e-invoice: a ZUGFeRD PDF (EN 16931 profile) with the XML inside.
//
// Each XML is checked against the official schema and the official EN 16931 business rules
// before it is used. The rules file comes from the EU project eInvoicing-EN16931 (EUPL 1.2),
// compiled once to a Saxon-JS stylesheet (assets/rules).
import fontkit from "@pdf-lib/fontkit";
import { buildXml as buildCiiXml, embedFacturX, extractXml, Flavor, Profile, validateXsd } from "@stackforge-eu/factur-x";
import type { FacturXInvoiceInput } from "@stackforge-eu/factur-x";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import SaxonJS from "saxon-js";
import { InvoiceFacts, vatGroups } from "./compliance";
import { germanDate, IsoDate } from "./dates";
import { decimalText, eur, eurDe, toEuros } from "./money";

const ASSETS = join(__dirname, "..", "assets");
export const SMALL_BUSINESS_REASON = "Kleinunternehmer gemäß § 19 UStG";

export const LABELS = {
  de: {
    invoice: "Rechnung", credit: "Stornorechnung", vat_id: "USt-IdNr.", tax_no: "Steuernummer",
    service: "Leistungsdatum", date: "Rechnungsdatum", credit_date: "Datum", due: "Zahlbar bis",
    cancels: "Storniert Rechnung", of: "vom", pos: "Pos.", item: "Beschreibung", qty: "Menge",
    unit_price: "Einzelpreis", net: "Netto", sum_net: "Summe netto", vat: "USt.", total: "Gesamtbetrag",
    pay: "Online bezahlen mit PayPal", pay_short: "Online bezahlen", footer: "Erstellt mit PaidLoop. Keine Steuer- oder Rechtsberatung.",
  },
  en: {
    invoice: "Invoice", credit: "Credit note", vat_id: "VAT ID", tax_no: "Tax number",
    service: "Date of service", date: "Invoice date", credit_date: "Date", due: "Due by",
    cancels: "Cancels invoice", of: "of", pos: "No.", item: "Description", qty: "Qty",
    unit_price: "Unit price", net: "Net", sum_net: "Net total", vat: "VAT", total: "Total",
    pay: "Pay online with PayPal", pay_short: "Pay online", footer: "Created with PaidLoop. Not tax or legal advice.",
  },
} as const;

export class EInvoiceInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

export interface EInvoice {
  xml: Buffer;
  pdf: Buffer;
  rules_checked: number;
}

/** The invoice this one cancels: its number and issue date. */
export type Corrects = [number: string, issued: IsoDate];

const quantity = (milli: number): number => milli / 1000;

// ---------------------------------------------------------------- the XML

export function buildInput(facts: InvoiceFacts, number: string, units: readonly string[], notes: string[], payLink: string | null, corrects: Corrects | null = null): FacturXInvoiceInput {
  const small = facts.seller_small_business;
  const category = small ? "E" : "S";
  const labels = LABELS[facts.buyer_language === "en" ? "en" : "de"];
  const netTotal = facts.lines.reduce((sum, line) => sum + line.net_cents, 0);

  const registrations: { id: string; schemeId: "VA" | "FC" }[] = [];
  if (facts.seller_vat_id) registrations.push({ id: facts.seller_vat_id, schemeId: "VA" });
  if (facts.seller_tax_number) registrations.push({ id: facts.seller_tax_number, schemeId: "FC" });

  const address = (party: InvoiceFacts["seller"]) => ({
    line1: party.street, city: party.city, postalCode: party.postcode, country: party.country || "DE",
  });

  const input: FacturXInvoiceInput = {
    document: {
      id: number,
      issueDate: facts.issue_date!,
      typeCode: (corrects ? "381" : "380") as never,
      ...(notes.length ? { notes: notes.map((content) => ({ content })) } : {}),
    },
    seller: {
      name: facts.seller.name,
      address: address(facts.seller),
      taxRegistrations: registrations,
      // Rule BR-CO-26 needs a seller ID. Many small businesses only have a tax number.
      ...(!facts.seller_vat_id && facts.seller_tax_number ? { id: facts.seller_tax_number } : {}),
    },
    buyer: { name: facts.buyer.name, address: address(facts.buyer) },
    // A missing service date means the invoice date, as for invoices up to 250 EUR (Sec. 33 UStDV)
    delivery: { date: facts.service_date ?? facts.issue_date! },
    lines: facts.lines.map((line, index) => ({
      id: String(index + 1),
      name: line.description,
      quantity: quantity(line.quantity_milli),
      unitCode: units[index],
      unitPrice: toEuros(line.unit_price_cents),
      lineTotal: toEuros(line.net_cents),
      vatCategoryCode: category,
      vatRatePercent: line.vat_bp / 100,
    })),
    totals: {
      lineTotal: toEuros(netTotal),
      allowanceTotal: 0,
      chargeTotal: 0,
      taxBasisTotal: toEuros(netTotal),
      taxTotal: toEuros(facts.vat_cents),
      grandTotal: toEuros(facts.gross_cents),
      duePayableAmount: toEuros(facts.gross_cents),
      currency: "EUR",
    },
    vatBreakdown: [...vatGroups(facts.lines)].sort((a, b) => a[0] - b[0]).map(([bp, [net, vat]]) => ({
      categoryCode: category,
      ratePercent: bp / 100,
      taxableAmount: toEuros(net),
      taxAmount: toEuros(vat),
      ...(small ? { exemptionReason: SMALL_BUSINESS_REASON } : {}),
    })),
  };

  if (corrects) {
    input.references = [{ id: corrects[0], type: "preceding", issueDate: corrects[1] }];
  } else {
    let terms = `${labels.due} ${germanDate(facts.due_date!)}.`;
    if (payLink) terms += ` ${labels.pay_short}: ${payLink}`;
    input.payment = { meansCode: "68", dueDate: facts.due_date!, termsDescription: terms }; // 68 = online payment service
  }
  return input;
}

/** The CII XML. Throws if the data cannot form a valid document. */
export function buildXml(facts: InvoiceFacts, number: string, units: readonly string[], notes: string[], payLink: string | null, corrects: Corrects | null = null): string {
  return buildCiiXml(buildInput(facts, number, units, notes, payLink, corrects), Profile.EN16931, Flavor.ZUGFERD);
}

// ---------------------------------------------------------------- the official rules

type Stylesheet = Record<string, unknown>;
let stylesheet: Stylesheet | undefined;

function rulesStylesheet(): Stylesheet {
  stylesheet ??= JSON.parse(gunzipSync(readFileSync(join(ASSETS, "rules", "EN16931-CII-validation.sef.json.gz"))).toString("utf8"));
  return stylesheet!;
}

/** Run the official EN 16931 rules. Returns the fatal problems and the number of rules checked. */
export async function validateRules(xml: string | Buffer): Promise<{ problems: string[]; checked: number }> {
  try {
    const { principalResult } = await SaxonJS.transform(
      { stylesheetInternal: rulesStylesheet(), sourceText: xml.toString(), destination: "serialized" } as never,
      "async",
    );
    const report = String(principalResult);
    const problems: string[] = [];
    for (const match of report.matchAll(/<svrl:failed-assert\b([^>]*)>[\s\S]*?<svrl:text>([\s\S]*?)<\/svrl:text>/g)) {
      const flag = /\bflag="([^"]*)"/.exec(match[1])?.[1] ?? "fatal";
      if (flag === "fatal") problems.push(`${/\bid="([^"]*)"/.exec(match[1])?.[1]}: ${match[2].replace(/\s+/g, " ").trim()}`);
    }
    return { problems, checked: (report.match(/<svrl:fired-rule\b/g) ?? []).length };
  } catch (error) {
    // Fail closed: without a working check, no invoice goes out.
    return { problems: [`The official rule check could not run: ${(error as Error).message}`], checked: 0 };
  }
}

// ---------------------------------------------------------------- the readable PDF

const A4: [number, number] = [595.28, 841.89];

class Pen {
  constructor(readonly page: PDFPage, readonly regular: PDFFont, readonly bold: PDFFont) {}

  text(value: string, x: number, y: number, size = 9, bold = false): void {
    const clean = value.replace(/\s+/g, " ");
    if (clean) this.page.drawText(clean, { x, y, size, font: bold ? this.bold : this.regular, color: rgb(0, 0, 0) });
  }

  right(value: string, x: number, y: number, size = 9, bold = false): void {
    const font = bold ? this.bold : this.regular;
    const clean = value.replace(/\s+/g, " ");
    this.text(clean, x - font.widthOfTextAtSize(clean, size), y, size, bold);
  }

  rule(x1: number, y: number, x2: number): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.8, color: rgb(0, 0, 0) });
  }

  /** Breaks text into lines no wider than `width`. A word longer than a line is cut. */
  wrap(value: string, width: number, size = 9): string[] {
    const font = this.regular;
    const lines: string[] = [];
    let current = "";
    const fits = (candidate: string): boolean => font.widthOfTextAtSize(candidate, size) <= width;
    for (const word of value.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (!fits(rest)) {
        // cut a too-long word at the longest piece that still fits
        let cut = rest.length - 1;
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
        if (current) { lines.push(current); current = ""; }
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      const next = current ? `${current} ${rest}` : rest;
      if (fits(next)) current = next;
      else { lines.push(current); current = rest; }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }
}

const fontBytes = (name: string): Buffer => readFileSync(join(ASSETS, name));

/** The readable part of the invoice, in the customer's language. */
export async function buildPdf(facts: InvoiceFacts, number: string, notes: string[], payLink: string | null, qrPng: Uint8Array | null, corrects: Corrects | null = null): Promise<Uint8Array> {
  const labels = LABELS[facts.buyer_language === "en" ? "en" : "de"];
  const money = facts.buyer_language === "en" ? eur : eurDe;
  const title = corrects ? labels.credit : labels.invoice;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fontBytes("Vera.ttf"), { subset: true });
  const bold = await pdf.embedFont(fontBytes("VeraBd.ttf"), { subset: true });
  pdf.setTitle(`${title} ${number}`);
  pdf.setAuthor(facts.seller.name);
  pdf.setSubject(title);
  pdf.setProducer("PaidLoop");
  pdf.setCreator("PaidLoop");

  const pen = new Pen(pdf.addPage(A4), regular, bold);
  const left = 55;
  const right = 540;
  let y = 790;

  pen.text(facts.seller.name, left, y, 13, true);
  y -= 14;
  pen.text(`${facts.seller.street}, ${facts.seller.postcode} ${facts.seller.city}`, left, y);
  const taxId = facts.seller_vat_id ? `${labels.vat_id}: ${facts.seller_vat_id}` : `${labels.tax_no}: ${facts.seller_tax_number}`;
  y -= 12;
  pen.text(taxId, left, y);

  y -= 42;
  for (const line of [facts.buyer.name, facts.buyer.street, `${facts.buyer.postcode} ${facts.buyer.city}`.trim()]) {
    if (line) {
      pen.text(line, left, y, 10);
      y -= 14;
    }
  }

  y -= 16;
  pen.text(`${title} ${number}`, left, y, 16, true);
  y -= 20;
  const service = facts.service_date ? `${labels.service}: ${germanDate(facts.service_date)}   ` : "";
  if (corrects) {
    pen.text(`${labels.credit_date}: ${germanDate(facts.issue_date!)}   ${service}${labels.cancels} ${corrects[0]} ${labels.of} ${germanDate(corrects[1])}`, left, y);
  } else {
    pen.text(`${labels.date}: ${germanDate(facts.issue_date!)}   ${service}${labels.due}: ${germanDate(facts.due_date!)}`, left, y);
  }

  y -= 28;
  pen.text(`${labels.pos}  ${labels.item}`, left, y, 9, true);
  pen.right(labels.qty, 390, y, 9, true);
  pen.right(labels.unit_price, 460, y, 9, true);
  pen.right(labels.net, right, y, 9, true);
  y -= 5;
  pen.rule(left, y, right);
  facts.lines.forEach((line, index) => {
    const wrapped = pen.wrap(line.description, 270);
    y -= 14;
    pen.text(String(index + 1), left, y);
    pen.text(wrapped[0], left + 28, y);
    pen.right(String(quantity(line.quantity_milli)), 390, y);
    pen.right(money(line.unit_price_cents), 460, y);
    pen.right(money(line.net_cents), right, y);
    for (const extra of wrapped.slice(1)) {
      y -= 12;
      pen.text(extra, left + 28, y);
    }
  });

  y -= 8;
  pen.rule(left, y, right);
  y -= 16;
  pen.right(labels.sum_net, 460, y);
  pen.right(money(facts.lines.reduce((sum, line) => sum + line.net_cents, 0)), right, y);
  if (!facts.seller_small_business) {
    for (const [bp, [, vat]] of [...vatGroups(facts.lines)].sort((a, b) => a[0] - b[0])) {
      y -= 14;
      pen.right(`${labels.vat} ${(bp / 100).toFixed(0)} %`, 460, y);
      pen.right(money(vat), right, y);
    }
  }
  y -= 18;
  pen.right(labels.total, 460, y, 11, true);
  pen.right(money(facts.gross_cents), right, y, 11, true);

  y -= 32;
  for (const note of notes) {
    for (const line of pen.wrap(note, right - left)) {
      pen.text(line, left, y);
      y -= 12;
    }
    y -= 4;
  }

  if (payLink) {
    y -= 8;
    pen.text(labels.pay, left, y, 10, true);
    y -= 13;
    for (const line of pen.wrap(payLink, 340, 8)) {
      pen.text(line, left, y, 8);
      y -= 10;
    }
    if (qrPng) {
      const image = await pdf.embedPng(qrPng);
      pen.page.drawImage(image, { x: 440, y: y - 60, width: 100, height: 100 });
    }
  }

  pen.text(labels.footer, left, 40, 7);
  return pdf.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------- put it together

/** Build and validate. Throws EInvoiceInvalid rather than ever returning a broken invoice. */
export async function create(
  facts: InvoiceFacts,
  number: string,
  units: readonly string[],
  notes: string[],
  payLink: string | null,
  qrPng: Uint8Array | null = null,
  corrects: Corrects | null = null,
): Promise<EInvoice> {
  let xml: string;
  try {
    xml = buildXml(facts, number, units, notes, payLink, corrects);
    const schema = await validateXsd(xml, Profile.EN16931);
    if (!schema.valid) throw new Error(schema.errors.map((e) => e.message).join("; "));
  } catch (error) {
    // the library reports schema problems with several error types
    throw new EInvoiceInvalid([`Schema: ${(error as Error).message}`]);
  }
  const { problems, checked } = await validateRules(xml);
  if (problems.length) throw new EInvoiceInvalid(problems);
  const visual = await buildPdf(facts, number, notes, payLink, qrPng, corrects);
  const result = await embedFacturX({
    pdf: Buffer.from(visual),
    xml,
    profile: Profile.EN16931,
    flavor: Flavor.ZUGFERD,
    rgbIccProfile: fontBytes("sRGB.icc"),
    unembeddedFonts: "throw",
  });
  return { xml: Buffer.from(xml, "utf8"), pdf: Buffer.from(result.pdf), rules_checked: checked };
}

export async function readBackXml(pdf: Uint8Array): Promise<Buffer | null> {
  try {
    return Buffer.from((await extractXml(pdf)).xml, "utf8");
  } catch {
    return null;
  }
}

export { decimalText };
