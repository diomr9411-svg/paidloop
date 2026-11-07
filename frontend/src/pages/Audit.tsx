import { useEffect, useState } from "react";

import { api } from "../api";

function detail(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .filter(([key]) => !["paypal_ids", "paypal_id", "paypal_payment_id"].includes(key))
    .map(([key, value]) => {
      if (key.endsWith("_cents") && typeof value === "number") return `${key.replace("_cents", "")}: ${(value / 100).toFixed(2)} EUR`;
      return `${key.replaceAll("_", " ")}: ${Array.isArray(value) ? value.join(", ") : value}`;
    });
  return parts.join(" · ");
}

export function Audit({ version }: { version: number }) {
  const [log, setLog] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/audit").then(setLog).catch((e) => setError(e.message));
  }, [version]);

  if (error) return <div className="alert error">{error}</div>;
  if (!log) return <p className="muted">Loading...</p>;

  return (
    <>
      <h1>Audit trail</h1>
      <p className="muted">
        Every step, and who did it. Each row includes the fingerprint of the row before, so a changed or deleted row is detected. This helps with
        traceability, but it is not a GoBD certification.
      </p>
      <div className={`alert ${log.chain.ok ? "good" : "error"}`}>
        {log.chain.ok
          ? `✓ Chain intact: ${log.chain.checked} entries checked.`
          : `! Chain broken at entry ${log.chain.broken_at}. A record was changed.`}
      </div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Who</th>
              <th>What</th>
              <th>Invoice</th>
              <th>Details</th>
              <th>Fingerprint</th>
            </tr>
          </thead>
          <tbody>
            {log.events.map((event: any) => (
              <tr key={event.id}>
                <td className="nowrap muted">{event.at.slice(0, 16).replace("T", " ")}</td>
                <td>
                  <span className={`actor ${event.actor}`}>{event.actor}</span>
                </td>
                <td>{event.action.replaceAll("_", " ")}</td>
                <td>{event.invoice_id ? <a href={`#/invoices/${event.invoice_id}`}>{event.invoice_id}</a> : "-"}</td>
                <td className="small muted">{detail(event.data)}</td>
                <td className="mono small muted">{event.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
