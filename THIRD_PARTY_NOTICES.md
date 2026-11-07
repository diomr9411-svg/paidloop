# Third-party notices

PaidLoop's own code is under the MIT license (see `LICENSE`). It uses these separately licensed works:

| Work | Use | License |
|---|---|---|
| `backend/assets/rules/EN16931-CII-validation.xslt`, from [eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931) | Official EN 16931 business rules, unchanged. The `.sef.json.gz` next to it is the same file compiled for Saxon-JS | EUPL 1.2 |
| [@stackforge-eu/factur-x](https://www.npmjs.com/package/@stackforge-eu/factur-x) | ZUGFeRD XML, schema check, PDF/A-3 embedding. Used as a library, not changed | EUPL 1.2 |
| [Saxon-JS](https://www.npmjs.com/package/saxon-js) by Saxonica | Runs the official rules. Free to use inside an app; its licence does not allow hosting the package itself for other people | Saxonica Saxon-JS licence |
| [pdf-lib](https://www.npmjs.com/package/pdf-lib), [pdf.js](https://www.npmjs.com/package/pdfjs-dist) | PDF creation and reading | MIT, Apache 2.0 |
| Bitstream Vera fonts (`backend/assets/Vera*.ttf`) | Font inside the invoice PDF | Bitstream Vera license |
| [Tesseract.js](https://www.npmjs.com/package/tesseract.js) with `@tesseract.js-data` English and German | Reads text from photos on your own computer | Apache 2.0, MIT |
| [NestJS](https://nestjs.com), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [zod](https://zod.dev) | Server, database, input checks | MIT |
| [Ollama](https://ollama.com) with a model of your choice | Local AI, not included in this repo | See each project |

Others are listed in `backend/package.json` and `frontend/package.json`, each under its own open source license.
