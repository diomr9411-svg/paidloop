// Spike: can TypeScript tools make an EN 16931 ZUGFeRD invoice and check it with the official rules?
import { readFileSync, writeFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import SaxonJS from "saxon-js";
import { buildXml, embedFacturX, extractXml, Flavor, Profile, validateInput, validateXsd, VatCategoryCode } from "@stackforge-eu/factur-x";

const rules = JSON.parse(readFileSync(new URL("./rules.sef.json", import.meta.url), "utf8"));

async function officialRules(xml) {
  const { principalResult } = await SaxonJS.transform({ stylesheetInternal: rules, sourceText: xml, destination: "serialized" }, "async");
  const failed = [...principalResult.matchAll(/<svrl:failed-assert[^>]*id="([^"]+)"[^>]*>[\s\S]*?<svrl:text>([\s\S]*?)<\/svrl:text>/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
  const fired = (principalResult.match(/<svrl:fired-rule/g) || []).length;
  return { failed, fired };
}

const input = (overrides = {}) => ({
  document: { id: "RE-2026-0001", issueDate: "2026-11-07", typeCode: "380" },
  seller: { name: "Muster Handwerk", address: { line1: "Hauptstr. 1", city: "Lemgo", postalCode: "32657", country: "DE" }, taxRegistrations: [{ id: "DE123456789", schemeId: "VA" }] },
  buyer: { name: "Kunde GmbH", address: { line1: "Marktplatz 2", city: "Detmold", postalCode: "32756", country: "DE" } },
  lines: [{ id: "1", name: "Montage", quantity: 3.5, unitCode: "HUR", unitPrice: 60, vatCategoryCode: VatCategoryCode.STANDARD_RATE, vatRatePercent: 19 }],
  totals: { lineTotal: 210, taxBasisTotal: 210, taxTotal: 39.9, grandTotal: 249.9, duePayableAmount: 249.9, currency: "EUR" },
  vatBreakdown: [{ categoryCode: VatCategoryCode.STANDARD_RATE, ratePercent: 19, taxableAmount: 210, taxAmount: 39.9 }],
  payment: { meansCode: "68", dueDate: "2026-11-21" },
  delivery: { date: "2026-11-05" },
  ...overrides,
});

const log = (name, ok, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);

const data = input();
const check = validateInput(data, Profile.EN16931);
log("input accepted", check.valid, JSON.stringify(check.errors || ""));

const xml = buildXml(data, Profile.EN16931, Flavor.ZUGFERD);
const xsd = await validateXsd(xml, Profile.EN16931);
log("schema (XSD)", xsd.valid, JSON.stringify(xsd.errors || ""));
const good = await officialRules(xml);
log("official EN 16931 rules, good invoice", good.failed.length === 0, `rules fired: ${good.fired} ${good.failed.join(" | ")}`);

// A wrong total must be caught by the official rules
const bad = buildXml(input({ totals: { lineTotal: 210, taxBasisTotal: 210, taxTotal: 39.9, grandTotal: 250.9, duePayableAmount: 250.9, currency: "EUR" } }), Profile.EN16931, Flavor.ZUGFERD);
const badResult = await officialRules(bad);
log("official rules catch a wrong total", badResult.failed.length > 0, badResult.failed.slice(0, 2).join(" | "));

// PDF with the XML inside
const pdf = await PDFDocument.create();
pdf.registerFontkit(fontkit);
const font = await pdf.embedFont(readFileSync(new URL("./assets/Vera.ttf", import.meta.url)), { subset: true });
pdf.addPage().drawText("Rechnung RE-2026-0001 Müller 249,90 €", { x: 50, y: 780, size: 18, font });
const result = await embedFacturX({ pdf: Buffer.from(await pdf.save()), input: data, profile: Profile.EN16931, flavor: Flavor.ZUGFERD, rgbIccProfile: readFileSync(new URL("./assets/sRGB.icc", import.meta.url)) });
writeFileSync(new URL("./out.pdf", import.meta.url), result.pdf);
const back = await extractXml(result.pdf);
log("PDF made, XML extracted back", !!back.xml && back.xml.includes("RE-2026-0001"), `${result.pdf.length} bytes, profile ${back.profile}`);
