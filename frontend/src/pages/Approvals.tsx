import { useEffect, useState } from "react";

import { ACTION_LABEL, api, eur, post } from "../api";

const CUSTOMER_REQUEST = new Set(["plan_exception", "dispute_review", "payment_check"]);
const BUTTONS: Record<string, [string, string]> = {
  plan_exception: ["Offer a payment plan", "Say no"],
  dispute_review: ["Problem solved, continue reminders", "Keep on hold"],
  payment_check: ["No payment found, continue reminders", "Keep waiting"],
  owner_review: ["Mark as reviewed", "Not now"],
};

function ApprovalCard({ item, done }: { item: any; done: (message: string) => void }) {
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fromCustomer = CUSTOMER_REQUEST.has(item.action);
  const [yes, no] = BUTTONS[item.action] || ["Approve and send", "Not now"];

  async function decide(path: string, payload?: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await post(`/api/approvals/${item.id}/${path}`, payload);
      done(result.message);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="title-row">
        <h2>{ACTION_LABEL[item.action] || item.action}</h2>
        <span className="chip">{item.decided_by_ai ? "Suggested by AI, limits checked" : "Suggested by rules"}</span>
      </div>
      <p>
        <a href={`#/invoices/${item.invoice.id}`}>{item.invoice.number}</a>, {item.invoice.customer?.name}, {eur(item.invoice.open_cents)} open
        {item.invoice.days_overdue > 0 ? `, ${item.invoice.days_overdue} days late` : ""}
      </p>
      <p className="why">
        <strong>Why:</strong> {item.reason}
      </p>
      {fromCustomer ? (
        <blockquote>{item.body}</blockquote>
      ) : (
        item.action !== "owner_review" && (
          <>
            <label className="wide">
              Message to the customer: {item.subject}
              <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            {item.english && item.english !== item.body && (
              <details>
                <summary>Read this in English</summary>
                <p className="pre small">{item.english}</p>
              </details>
            )}
          </>
        )
      )}
      {error && <div className="alert error">{error}</div>}
      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => decide("approve", body !== item.body ? { body } : {})}>
          {yes}
        </button>
        <button disabled={busy} onClick={() => decide("reject")}>
          {no}
        </button>
      </div>
    </section>
  );
}

export function Approvals({ version, refresh }: { version: number; refresh: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<any[]>("/api/approvals").then(setRows).catch((e) => setError(e.message));
  }, [version]);

  if (error) return <div className="alert error">{error}</div>;
  if (!rows) return <p className="muted">Loading...</p>;

  return (
    <>
      <h1>Approvals</h1>
      <p className="muted">The agent never takes these steps alone. You decide.</p>
      {message && <div className="alert good">✓ {message}</div>}
      {rows.length === 0 && <div className="card callout">Nothing is waiting for you.</div>}
      {rows.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          done={(text) => {
            setMessage(text);
            refresh();
          }}
        />
      ))}
    </>
  );
}
