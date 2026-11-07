import { useEffect, useState } from "react";

import { api, put } from "../api";

export function Settings({ refresh }: { refresh: () => void }) {
  const [form, setForm] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/business").then(setForm).catch((e) => setError(e.message));
  }, []);

  if (error && !form) return <div className="alert error">{error}</div>;
  if (!form) return <p className="muted">Loading...</p>;

  const text = (key: string, label: string) => (
    <label>
      {label}
      <input value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );
  const number = (key: string, label: string, hint: string) => (
    <label>
      {label}
      <input type="number" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
      <span className="muted small">{hint}</span>
    </label>
  );

  async function save() {
    setError("");
    setMessage("");
    try {
      setForm(await put("/api/business", form));
      setMessage("Saved.");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <section className="card">
        <h2>Your business</h2>
        <div className="form-grid">
          {text("name", "Name")}
          {text("email", "Email")}
          {text("street", "Street")}
          <div className="form-pair">
            {text("postcode", "Postcode")}
            {text("city", "City")}
          </div>
          {text("vat_id", "VAT ID (USt-IdNr.)")}
          {text("tax_number", "Tax number (Steuernummer)")}
          <label>
            VAT method
            <select value={form.vat_method} onChange={(e) => setForm({ ...form, vat_method: e.target.value })}>
              <option value="soll">Standard (Soll): VAT is due when you invoice</option>
              <option value="ist">Cash basis (Ist): VAT is due when you are paid</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.small_business} onChange={(e) => setForm({ ...form, small_business: e.target.checked })} />
            Small business (Sec. 19 UStG): I don't charge VAT
          </label>
        </div>
      </section>
      <section className="card">
        <h2>Limits for the agent</h2>
        <p className="muted">The AI can never go outside these. They are enforced in code, not in its instructions.</p>
        <div className="form-grid">
          {number("max_installments", "Most payments in a plan", "Between 2 and 12.")}
          {number("min_first_payment_pct", "Smallest first payment (%)", "Share of the open amount.")}
          {number("max_plan_days", "Longest plan (days)", "From the first to the last payment.")}
          {number("min_installment_eur", "Smallest payment (EUR)", "Smaller plans go to you to decide.")}
          {number("reminder_gap_days", "Days between reminders", "The agent waits at least this long.")}
          {number("payment_days", "Normal payment time (days)", "Used for the due date on new invoices.")}
        </div>
      </section>
      {error && <div className="alert error">{error}</div>}
      {message && <div className="alert good">✓ {message}</div>}
      <div className="button-row">
        <button className="primary" onClick={save}>
          Save settings
        </button>
      </div>
    </>
  );
}
