import { useEffect, useState } from "react";

import { api, day, eur, post } from "../api";
import { StatusPill } from "./Invoices";

export function InvoiceDetail({ id, version, refresh }: { id: number; version: number; refresh: () => void }) {
  const [invoice, setInvoice] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bank, setBank] = useState("");
  const [cancelStep, setCancelStep] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api(`/api/invoices/${id}`).then((data) => alive && setInvoice(data)).catch((e) => alive && setError(e.message));
      api(`/api/audit?invoice_id=${id}`).then((data) => alive && setEvents(data.events)).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, version]);

  async function act(action: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      setInvoice(await action());
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !invoice) return <div className="alert error">{error}</div>;
  if (!invoice) return <p className="muted">Loading...</p>;

  const open = ["issued", "on_plan", "disputed"].includes(invoice.status);
  const customerPage = invoice.public_token ? `#/pay/${invoice.public_token}` : null;

  return (
    <>
      <div className="title-row">
        <div>
          <a className="muted small" href="#/invoices">
            ← All invoices
          </a>
          <h1>{invoice.number || `Draft ${invoice.id}`}</h1>
        </div>
        <StatusPill status={invoice.status} overdue={invoice.days_overdue} />
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="columns wide-left">
        <section className="card">
          <h2>{invoice.customer?.name}</h2>
          <p className="muted">
            {invoice.customer?.is_business ? "Business customer" : "Private customer"}
            {invoice.customer?.city ? `, ${invoice.customer.city}` : ""}
          </p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line: any, index: number) => (
                <tr key={index}>
                  <td>{line.description}</td>
                  <td className="num">
                    {line.quantity} {line.unit === "HUR" ? "h" : ""}
                  </td>
                  <td className="num">{eur(line.unit_price_cents)}</td>
                  <td className="num">{eur(line.net_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Net</td>
                <td className="num">{eur(invoice.net_cents)}</td>
              </tr>
              <tr>
                <td colSpan={3}>VAT</td>
                <td className="num">{eur(invoice.vat_cents)}</td>
              </tr>
              <tr className="total">
                <td colSpan={3}>Total</td>
                <td className="num">{eur(invoice.gross_cents)}</td>
              </tr>
              <tr>
                <td colSpan={3}>Paid</td>
                <td className="num">{eur(invoice.paid_cents)}</td>
              </tr>
              <tr className="total">
                <td colSpan={3}>Still open</td>
                <td className="num">{eur(invoice.open_cents)}</td>
              </tr>
            </tfoot>
          </table>
          <dl className="facts">
            <dt>Invoice date</dt>
            <dd>{day(invoice.issue_date)}</dd>
            <dt>Work done on</dt>
            <dd>{day(invoice.service_date)}</dd>
            <dt>Due</dt>
            <dd>{day(invoice.due_date)}</dd>
          </dl>
        </section>

        <section className="stack">
          <div className="card">
            <h2>Documents and links</h2>
            <div className="button-row">
              <a className="button" href={`/api/invoices/${id}/pdf`}>
                E-invoice PDF
              </a>
              <a className="button" href={`/api/invoices/${id}/xml`}>
                XML
              </a>
              {invoice.pay_link && !invoice.plan && (
                <a className="button" href={invoice.pay_link} target="_blank" rel="noreferrer">
                  PayPal link
                </a>
              )}
              {customerPage && (
                <a className="button primary" href={customerPage} target="_blank" rel="noreferrer">
                  Customer page
                </a>
              )}
            </div>
            <p className="muted small">The PDF is a ZUGFeRD e-invoice with the XML inside. It passed the official EN 16931 rules before it was issued.</p>
          </div>

          {invoice.risk && open && (
            <div className="card">
              <h2>Payment risk: {invoice.risk.level}</h2>
              <ul className="plain">
                {invoice.risk.reasons.map((reason: string) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {invoice.late_costs?.in_default && (
                <p className="small">
                  In default since {day(invoice.late_costs.default_since)}. You could claim {eur(invoice.late_costs.interest_cents)} interest at{" "}
                  {invoice.late_costs.rate_percent}% a year
                  {invoice.late_costs.flat_fee_cents ? ` and a ${eur(invoice.late_costs.flat_fee_cents)} flat fee` : ""}.
                </p>
              )}
            </div>
          )}

          {invoice.plan && (
            <div className="card">
              <h2>Payment plan</h2>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Due</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.plan.installments.map((item: any) => (
                    <tr key={item.seq}>
                      <td>{item.seq}</td>
                      <td>{day(item.due_date)}</td>
                      <td className="num">{eur(item.amount_cents)}</td>
                      <td>{item.is_paid ? "✓ Paid" : "Open"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {open && (
            <div className="card">
              <h2>Other actions</h2>
              {invoice.status !== "on_plan" && (
                <div className="inline-form">
                  <label>
                    Customer paid by bank transfer (EUR)
                    <input value={bank} inputMode="decimal" placeholder={(invoice.open_cents / 100).toFixed(2)} onChange={(e) => setBank(e.target.value)} />
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const amount = Number((bank || String(invoice.open_cents / 100)).replace(",", "."));
                      if (!(amount > 0)) {
                        setError("Please enter an amount above zero.");
                        return;
                      }
                      act(() => post(`/api/invoices/${id}/record-payment`, { amount_eur: amount })).then(() => setBank(""));
                    }}
                  >
                    Record payment
                  </button>
                </div>
              )}
              {invoice.paid_cents === 0 && (
                <div className="button-row">
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (!cancelStep) {
                        setCancelStep(true);
                        return;
                      }
                      setCancelStep(false);
                      act(() => post(`/api/invoices/${id}/cancel`, { reason: "Cancelled by the owner" }));
                    }}
                  >
                    {cancelStep ? "Yes, cancel this invoice" : "Cancel invoice"}
                  </button>
                </div>
              )}
              {cancelStep && <p className="muted small">The record is kept. The ledger entry is reversed and the PayPal request is cancelled.</p>}
            </div>
          )}
        </section>
      </div>

      {invoice.messages.length > 0 && (
        <section className="card">
          <h2>Chat with the customer</h2>
          <div className="chat readonly">
            {invoice.messages.map((message: any, index: number) => (
              <div key={index} className={`bubble ${message.role}`}>
                {message.text}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>What happened</h2>
        <table>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="nowrap muted">{event.at.slice(0, 16).replace("T", " ")}</td>
                <td>
                  <span className={`actor ${event.actor}`}>{event.actor}</span>
                </td>
                <td>{event.action.replaceAll("_", " ")}</td>
                <td className="muted small">{event.data.reason || event.data.action || event.data.intent || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
