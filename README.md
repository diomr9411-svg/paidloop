# PaidLoop

AI agent that turns a messy job note into a German e-invoice with a PayPal pay link, and follows it until it is paid. PayPal AI Hackathon project.

**Work in progress.** It uses the free PayPal sandbox only, so no real money moves. Not tax or legal advice.

## Run it locally

Needs Python 3.12 and Node 18 or newer. These commands are for Git Bash on Windows. On macOS or Linux, use `.venv/bin/python` instead of `.venv/Scripts/python`.

Backend, from the repo root:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt
cp .env.example .env    # then fill in your own sandbox keys
cd backend
../.venv/Scripts/python -m uvicorn paidloop.main:app --reload
```

Frontend, in a second terminal, from the repo root:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Tests

```bash
cd backend
../.venv/Scripts/python -m pytest
```

## License

MIT
