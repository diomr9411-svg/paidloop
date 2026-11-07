import { Db } from "../src/db";

/** A fresh in-memory database with all tables, like the Python tests' `session` fixture. */
export function memoryDb(): Db {
  const db = new Db("sqlite:///:memory:");
  db.prepare();
  return db;
}

async function openPdf(pdf: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
}

/** All text on all pages, one line per drawn string. */
export async function pdfText(pdf: Uint8Array): Promise<string> {
  const doc = await openPdf(pdf);
  const lines: string[] = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const content = await (await doc.getPage(number)).getTextContent();
    for (const item of content.items) if ("str" in item && item.str.trim()) lines.push(item.str);
  }
  return lines.join("\n");
}

export async function pdfPages(pdf: Uint8Array): Promise<number> {
  return (await openPdf(pdf)).numPages;
}

/** True if the PDF catalog has this entry (works even when the PDF stores it in a compressed stream). */
export async function pdfCatalogHas(pdf: Uint8Array, key: string): Promise<boolean> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf);
  return doc.catalog.has(PDFName.of(key));
}
