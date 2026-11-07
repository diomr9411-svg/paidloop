# Third-party notices

PaidLoop's own code is under the MIT license (see `LICENSE`). It uses these separately licensed works:

| Work | Use | License |
|---|---|---|
| `backend/paidloop/rules/EN16931-CII-validation.xslt`, from [eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931) | Official EN 16931 business rules, unchanged | EUPL 1.2 |
| [drafthorse](https://pypi.org/project/drafthorse/) | ZUGFeRD XML and schema check | Apache 2.0 |
| [Saxon-HE (saxonche)](https://pypi.org/project/saxonche/) | Runs the official rules | MPL 2.0 |
| [ReportLab](https://pypi.org/project/reportlab/), including Bitstream Vera fonts | PDF creation | BSD style, Bitstream Vera license |
| [RapidOCR](https://pypi.org/project/rapidocr-onnxruntime/) | Reads text from photos on your own computer | Apache 2.0 |
| [Ollama](https://ollama.com) with a model of your choice | Local AI, not included in this repo | See each project |

Others are listed in `backend/requirements.txt` and `frontend/package.json`, each under its own open source license.
