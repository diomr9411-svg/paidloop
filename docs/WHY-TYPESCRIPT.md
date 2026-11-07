# Why the server is TypeScript (NestJS) now

PaidLoop's first server was written in Python (FastAPI). On 8 Nov 2026 the owner asked to move it to NestJS, and it was done in one go, with the old code kept in git history. This page says what was checked before and after.

## What changed, and what did not

| | Before | Now |
|---|---|---|
| Server | Python, FastAPI, SQLAlchemy | TypeScript, NestJS, better-sqlite3 |
| Screens | React + Vite | The same, unchanged |
| Addresses and answers of the server | | The same. A script compares both servers (`npm run compare`), and the real screens were walked on the new server: 143 of 143 clean |
| Database file | SQLite | SQLite, same tables. The new server reads a database made by the old one, and the audit chain still verifies |
| Tests | 285 | 313, including the same checks of query plans, query counts, both languages and the real attacks |

## Checks before the switch

A spike on 8 Nov 2026 (kept in git history under `backend-ts/spike`) tested the parts that could have failed:

| Check | Result |
|---|---|
| ZUGFeRD / EN 16931 XML with `@stackforge-eu/factur-x` | works |
| The official EN 16931 rules (61 rules) through Saxon-JS | pass on a good invoice, and catch a wrong total (BR-CO-15) |
| ZUGFeRD PDF with fonts and sRGB colour profile embedded | works, no PDF/A warning |
| Free offline photo reading with Tesseract.js and German data from npm | reads a German note, 6 of 6 key words, about 1.3 s |
| SQLite with indexes | prefix search on 20,000 rows uses the index, 6.6 ms |
| Ollama over plain `fetch` | works, no extra library |

Then the whole backend was ported module by module with its tests, and the same end-to-end story was run against the **real PayPal sandbox** ("All checks passed"): demo data, a new invoice with two VAT rates, bank payments, the agent, an approval, a payment plan with real pay links, plan payments closing the invoice, a dispute, the audit chain and the ledger.

## Differences you may notice

- **Faster.** Home takes about 33 ms and lists about 8 ms with 20,000 invoices (Python: 182 ms and 31 ms).
- **Delivery date.** The e-invoice library wants a delivery date. If the owner leaves the service date empty on a small invoice (up to EUR 250, Sec. 33 UStDV), the invoice date is used. The legal check still requires the service date for bigger invoices.
- **Photo reading** uses Tesseract.js instead of RapidOCR. Both run on the computer and send nothing out. They are different engines, so a few photos may read slightly differently.
- **Saxon-JS** (Saxonica) has its own licence. It may be used inside an app but the package may not be hosted for others. See `THIRD_PARTY_NOTICES.md`.

## Not checked

- PDF/A conformance with an outside validator (the Python version was not checked either).
- Photos of real handwritten notes with the new reader. Only two typed test images were used.
- Live PayPal webhooks (still needs a public address).
