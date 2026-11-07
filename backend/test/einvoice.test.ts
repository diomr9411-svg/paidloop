import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { InvoiceFacts, Line, party } from "../src/compliance";
import * as einvoice from "../src/einvoice";
import { pdfCatalogHas, pdfPages, pdfText } from "./helpers";

const line = (description: string, quantity_milli: number, unit_price_cents: number, vat_bp: number, net_cents: number): Line => ({
  description, quantity_milli, unit_price_cents, vat_bp, net_cents,
});

export const FACTS: InvoiceFacts = {
  seller: party({ name: "Muster Elektro GmbH", street: "Beispielstraße 1", postcode: "32657", city: "Lemgo", email: "a@example.com" }),
  buyer: party({ name: "Bäckerei Müller GmbH", street: "Musterweg 2", postcode: "32756", city: "Detmold", email: "b@example.com" }),
  seller_vat_id: "DE123456789",
  seller_tax_number: "",
  seller_small_business: false,
  buyer_is_business: true,
  issue_date: "2026-11-07",
  service_date: "2026-11-05",
  due_date: "2026-11-21",
  property_work: false,
  lines: [line("Badreparatur, Arbeitszeit", 4000, 6500, 1900, 26000), line("Material", 1000, 12000, 1900, 12000)],
  vat_cents: 7220,
  gross_cents: 45220,
  buyer_language: "de",
};
const UNITS = ["HUR", "H87"];
const tag = (xml: Buffer | string, name: string): string | undefined => new RegExp(`<ram:${name}[^>]*>([^<]*)</ram:${name}>`).exec(xml.toString())?.[1];

describe("e-invoice", () => {
  it("a valid invoice passes the official rules", async () => {
    const result = await einvoice.create(FACTS, "RE-2026-0001", UNITS, [], "https://example.com/pay");
    expect(result.rules_checked).toBeGreaterThan(50);
    expect((await einvoice.validateRules(result.xml)).problems).toEqual([]);
  });

  it("the PDF contains the same XML and the German text", async () => {
    const result = await einvoice.create(FACTS, "RE-2026-0001", UNITS, ["Testhinweis"], "https://example.com/pay");
    expect((await einvoice.readBackXml(result.pdf))!.equals(result.xml)).toBe(true);
    const text = await pdfText(result.pdf);
    for (const part of ["Rechnung RE-2026-0001", "Bäckerei Müller GmbH", "Beispielstraße", "452,20 EUR", "Testhinweis"]) expect(text).toContain(part);
    expect(await pdfCatalogHas(result.pdf, "OutputIntents")).toBe(true);
  });

  it("the totals in the XML are correct", async () => {
    const { xml } = await einvoice.create(FACTS, "RE-1", UNITS, [], null);
    expect(tag(xml, "GrandTotalAmount")).toBe("452.20");
    expect(tag(xml, "TaxTotalAmount")).toBe("72.20");
    expect(tag(xml, "DuePayableAmount")).toBe("452.20");
  });

  it("two VAT rates are split", async () => {
    const facts = { ...FACTS, lines: [line("Arbeit", 1000, 10000, 1900, 10000), line("Buch", 1000, 2000, 700, 2000)], vat_cents: 2040, gross_cents: 14040 };
    const result = await einvoice.create(facts, "RE-2", ["H87", "H87"], [], null);
    expect((await einvoice.validateRules(result.xml)).problems).toEqual([]);
    const text = await pdfText(result.pdf);
    expect(text).toContain("USt. 19 %");
    expect(text).toContain("USt. 7 %");
  });

  it("a small business invoice passes the official rules", async () => {
    const facts: InvoiceFacts = {
      ...FACTS, seller_small_business: true, seller_vat_id: "", seller_tax_number: "330/1234/5678",
      lines: [line("Arbeit", 1000, 10000, 0, 10000)], vat_cents: 0, gross_cents: 10000,
    };
    const result = await einvoice.create(facts, "RE-3", ["H87"], ["Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."], null);
    expect((await einvoice.validateRules(result.xml)).problems).toEqual([]);
    expect(result.xml.toString()).toContain("<ram:CategoryCode>E</ram:CategoryCode>");
  });

  it("the rules catch wrong totals", async () => {
    const good = einvoice.buildXml(FACTS, "RE-4", UNITS, [], null);
    const bad = good.replace(">452.20<", ">999.99<");
    expect(bad).not.toBe(good);
    expect((await einvoice.validateRules(bad)).problems.length).toBeGreaterThan(0);
  });

  it("broken data never produces an invoice", async () => {
    await expect(einvoice.create({ ...FACTS, gross_cents: 1 }, "RE-5", UNITS, [], null)).rejects.toBeInstanceOf(einvoice.EInvoiceInvalid);
  });

  it("a long description and the QR code fit on one page", async () => {
    const qr = await QRCode.toBuffer("https://example.com/pay");
    const facts = { ...FACTS, lines: [line("Sehr lange Beschreibung ".repeat(12), 1500, 6500, 1900, 9750)], vat_cents: 1853, gross_cents: 11603 };
    const result = await einvoice.create(facts, "RE-6", ["HUR"], [], "https://example.com/" + "a".repeat(120), qr);
    expect(await pdfPages(result.pdf)).toBe(1);
  });

  it("an English customer gets an English PDF", async () => {
    const result = await einvoice.create({ ...FACTS, buyer_language: "en" }, "RE-7", UNITS, [], "https://example.com/pay");
    const text = await pdfText(result.pdf);
    expect(text).toContain("Invoice RE-7");
    expect(text).toContain("452.20 EUR");
    expect(text).toContain("Invoice date");
  });

  it("a credit note refers to the invoice it cancels", async () => {
    const result = await einvoice.create(FACTS, "RE-2026-0002", UNITS, [], null, null, ["RE-2026-0001", "2026-11-07"]);
    expect(result.xml.toString()).toContain("<ram:TypeCode>381</ram:TypeCode>");
    expect(result.xml.toString()).toContain("RE-2026-0001");
    const text = await pdfText(result.pdf);
    expect(text).toContain("Stornorechnung RE-2026-0002");
    expect(text).toContain("Storniert Rechnung RE-2026-0001 vom 07.11.2026");
  });

  it("a small invoice without buyer address or service date still works", async () => {
    const facts: InvoiceFacts = {
      ...FACTS, seller_vat_id: "", buyer: party({ name: "Kunde", email: "b@example.com" }), service_date: null,
      lines: [line("Reparatur", 1000, 10000, 1900, 10000)], vat_cents: 1900, gross_cents: 11900,
    };
    const result = await einvoice.create(facts, "RE-8", ["H87"], [], null).catch((e) => e);
    // The seller has neither VAT id nor tax number here, which the official rules refuse (BR-CO-26)
    expect(result).toBeInstanceOf(einvoice.EInvoiceInvalid);
    const withTaxNumber = await einvoice.create({ ...facts, seller_tax_number: "330/1234/5678" }, "RE-8", ["H87"], [], null);
    expect((await einvoice.validateRules(withTaxNumber.xml)).problems).toEqual([]);
  });
});
