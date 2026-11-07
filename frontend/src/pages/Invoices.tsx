import { useEffect, useState } from "react";

import { api, day, eur, STATUS_LABEL } from "../api";

export function StatusPill({ status, overdue }: { status: string; overdue?: number }) {
  const tone = status === "paid" ? "good" : status === "disputed" || (overdue && overdue > 0 && status === "issued") ? "warn" : status === "cancelled" ? "" : "info";
  const text = status === "issued" && overdue && overdue > 0 ? `${overdue} days late` : STATUS_LABEL[status] || status;
  return (
    <span className={`pill ${tone}`}>
      {tone === "good" ? "✓ " : tone === "warn" ? "! " : ""}
      {text}
    </span>
  );
}

export function Invoices({ version }: { version: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<any[]>("/api/invoices").then(setRows).catch((e) => setError(e.message));
  }, [version]);

  if (error) return <div className="alert error">{error}</div>;
  if (!rows) return <p className="muted">Loading...</p>;

  return (
    <>
      <div className="title-row">
        <h1>Invoices</h1>
        <a className="button primary" href="#/new">
          New invoice
        </a>
      </div>
      {rows.length === 0 ? (
        <div className="card callout">No invoices yet.</div>
      ) : (
        <div className="card table-card">
          <table className="clickable">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onClick={() => (window.location.hash = `#/invoices/${row.id}`)}>
                  <td>
                    <a href={`#/invoices/${row.id}`}>{row.number || `Draft ${row.id}`}</a>
                  </td>
                  <td>{row.customer?.name || "-"}</td>
                  <td>{day(row.due_date)}</td>
                  <td>
                    <StatusPill status={row.status} overdue={row.days_overdue} />
                  </td>
                  <td className="num">{eur(row.gross_cents)}</td>
                  <td className="num">{eur(row.open_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
