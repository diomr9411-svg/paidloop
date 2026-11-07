import { useEffect, useState } from "react";

import { api, day, eur } from "../api";

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <div className={`card tile ${tone || ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-note">{note}</div>
    </div>
  );
}

function ForecastBars({ forecast }: { forecast: any }) {
  const rows: { label: string; cents: number; risk?: boolean; hint: string }[] = [
    { label: "Next 7 days", cents: forecast.week, hint: "Expected within a week, based on how each customer usually pays." },
    { label: "Next 30 days", cents: forecast.month, hint: "Expected within a month, based on how each customer usually pays." },
    { label: "Later", cents: forecast.later, hint: "Expected in more than 30 days." },
    { label: "At risk", cents: forecast.at_risk, risk: true, hint: "High-risk customers and invoices on hold. Don't plan with this money yet." },
  ];
  const largest = Math.max(...rows.map((row) => row.cents), 1);
  return (
    <div className="bars" role="list" aria-label="Money expected, by when it is likely to arrive">
      {rows.map((row) => (
        <div className="bar-row" key={row.label} role="listitem" title={`${row.label}: ${eur(row.cents)}. ${row.hint}`}>
          <div className="bar-label">
            {row.risk && (
              <span className="risk-icon" aria-hidden="true">
                !
              </span>
            )}
            {row.label}
          </div>
          <div className="bar-track">
            {row.cents > 0 && (
              <div className={`bar-fill ${row.risk ? "risk" : ""}`} style={{ width: `${Math.max((row.cents / largest) * 100, 1.5)}%` }} />
            )}
          </div>
          <div className="bar-value">{eur(row.cents)}</div>
        </div>
      ))}
    </div>
  );
}

export function Dashboard({ version }: { version: number }) {
  const [view, setView] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/dashboard")
        .then((data) => alive && setView(data))
        .catch((e) => alive && setError(e.message));
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [version]);

  if (error) return <div className="alert error">{error}</div>;
  if (!view) return <p className="muted">Loading...</p>;

  const empty = view.open_count === 0 && view.paid_count === 0;
  return (
    <>
      <h1>Your money today</h1>
      {empty && (
        <div className="card callout">
          <strong>Nothing here yet.</strong> <a href="#/new">Create your first invoice</a>, or click "Reset demo" above to see a full
          example.
        </div>
      )}
      {view.has_pending_approvals && (
        <a className="card callout attention" href="#/approvals">
          <strong>Some steps are waiting for your decision.</strong> Open approvals
        </a>
      )}

      <div className="hero card">
        <div className="tile-label">Money you can really spend</div>
        <div className={`hero-value ${view.spendable_cents < 0 ? "negative" : ""}`}>{eur(view.spendable_cents)}</div>
        <div className="tile-note">
          {eur(view.cash_cents)} received, minus {eur(view.vat_due_cents)} VAT that you have to pass on to the tax office.
          {view.vat_on_unpaid_cents > 0 &&
            ` This includes ${eur(view.vat_on_unpaid_cents)} VAT on invoices your customers haven't paid yet, because with standard (Soll) VAT it is due when you invoice.`}
        </div>
      </div>

      <div className="tiles">
        <Tile label="Waiting to be paid" value={eur(view.open_cents)} note={`${view.open_count} open invoices`} />
        <Tile label="Overdue" value={eur(view.overdue_cents)} note={`${view.overdue_count} invoices past the due date`} tone={view.overdue_count ? "warn" : ""} />
        <Tile label="On a payment plan" value={eur(view.on_plan_cents)} note="Agreed with the customer" />
        <Tile label="On hold" value={eur(view.disputed_cents)} note="Customer raised a problem" />
      </div>

      <div className="columns">
        <section className="card">
          <h2>When the money is likely to arrive</h2>
          <p className="muted">Estimated from how each customer has paid before. This is a guide, not a promise.</p>
          <ForecastBars forecast={view.forecast} />
        </section>
        <section className="card">
          <h2>Next expected payments</h2>
          {view.upcoming.length === 0 ? (
            <p className="muted">No open payments.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Expected</th>
                  <th>Customer</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {view.upcoming.map((item: any, index: number) => (
                  <tr key={index}>
                    <td>{day(item.expected_on)}</td>
                    <td>
                      {item.customer}
                      {item.risk === "high" && <span className="pill warn small-pill">! high risk</span>}
                    </td>
                    <td className="num">{eur(item.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <p className="muted small">
        Ledger check: {view.ledger_balanced ? "debits equal credits ✓" : "NOT balanced, please check the audit trail"}
      </p>
    </>
  );
}
