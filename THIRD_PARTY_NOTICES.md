# Third-party notices

PaidLoop's own code is under the MIT license (see `LICENSE`). It uses these separately licensed works:

| Work | Use | License |
|---|---|---|
| `backend/assets/rules/EN16931-CII-validation.xslt`, from [eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931) | Official EN 16931 business rules, unchanged. The `.sef.json.gz` next to it is the same file compiled for Saxon-JS | EUPL 1.2 |
| [@stackforge-eu/factur-x](https://www.npmjs.com/package/@stackforge-eu/factur-x) | ZUGFeRD XML, schema check, PDF/A-3 embedding. Used as a library, not changed | EUPL 1.2 |
| [Saxon-JS](https://www.npmjs.com/package/saxon-js) by Saxonica | Runs the official rules. Free to use inside an app; its licence does not allow hosting the package itself for other people | Saxonica Saxon-JS licence |
| [pdf-lib](https://www.npmjs.com/package/pdf-lib), [pdf.js](https://www.npmjs.com/package/pdfjs-dist) | PDF creation and reading | MIT, Apache 2.0 |
| Bitstream Vera fonts (`backend/assets/Vera*.ttf`) | Font inside the invoice PDF | Bitstream Vera license |
| [Tesseract.js](https://www.npmjs.com/package/tesseract.js) with `@tesseract.js-data` English and German | The basic reader for photos of printed notes, on your own computer | Apache 2.0, MIT |
| [Qwen3-VL 4B Instruct](https://ollama.com/library/qwen3-vl) by the Qwen team, run with [Ollama](https://ollama.com) | Optional. Reads photos and scans of handwritten notes on your own computer. You download it yourself; it is not part of this repo | Apache 2.0 |
| [NestJS](https://nestjs.com), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [zod](https://zod.dev) | Server, database, input checks | MIT |
| [Inter](https://rsms.me/inter/) by Rasmus Andersson, via [@fontsource-variable/inter](https://www.npmjs.com/package/@fontsource-variable/inter) | The typeface of the screens, served by the app itself | SIL Open Font License 1.1 |
| [Lucide](https://lucide.dev) icons | 73 icon drawings, copied into `frontend/src/assets/icons.svg` by `frontend/scripts/build-icons.mjs` | ISC |
| [axe-core](https://www.npmjs.com/package/axe-core), [ESLint](https://eslint.org) with jsx-a11y and react-hooks | Accessibility and code checks while building, not shipped | MPL 2.0, MIT |
| [Ollama](https://ollama.com) with a model of your choice | Local AI, not included in this repo | See each project |

Others are listed in `backend/package.json` and `frontend/package.json`, each under its own open source license.
