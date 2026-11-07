import { useEffect, useState } from "react";

import { api } from "../api";
import { ErrorBox, Loading } from "../components";
import { Tools, useT } from "../i18n";

const HIDDEN = new Set(["paypal_ids", "paypal_id", "paypal_payment_id", "reason_de", "issues", "error_count"]);

/** Turns the stored details of a step into a short readable line in the chosen language. */
export function eventText(data: Record<string, unknown>, tools: Tools): string {
  const { t, lang, labels, eur } = tools;
  return Object.entries(data)
    .filter(([key, value]) => !HIDDEN.has(key) && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => {
      const name = key.endsWith("_cents") ? key.replace("_cents", "") : key;
      const label = labels.field[name] || name.replaceAll("_", " ");
      let shown: unknown = value;
      if (key.endsWith("_cents") && typeof value === "number") shown = eur(value);
      else if (key === "reason" && lang === "de" && data.reason_de) shown = data.reason_de;
      else if (key === "action" || key === "proposed") shown = labels.action[String(value)] || value;
      else if (typeof value === "boolean") shown = value ? t("yes") : t("no");
      else if (Array.isArray(value)) shown = value.join(", ");
      else if (typeof value === "string" && labels.value[value]) shown = labels.value[value];
      return `${label}: ${shown}`;
    })
    .join(" · ");
}

export function Audit({ version }: { version: number }) {
  const tools = useT();
  const { t, labels, dateTime } = tools;
  const [events, setEvents] = useState<any[] | null>(null);
  const [nextId, setNextId] = useState<number | null>(null);
  const [chain, setChain] = useState<any>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api("/api/audit?limit=50")
      .then((body) => {
        setEvents(body.events);
        setNextId(body.next_before_id);
        setError("");
      })
      .catch((e) => setError(e.message));
    setChain(null);
    api("/api/audit/verify").then(setChain).catch(() => undefined);
  }, [version, attempt]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const body = await api(`/api/audit?limit=50&before_id=${nextId}`);
      setEvents((all) => [...(all || []), ...body.events]);
      setNextId(body.next_before_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (error && !events) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!events) return <Loading />;

  return (
    <>
      <h1>{t("audit")}</h1>
      <p className="muted">{t("auditIntro")}</p>
      {chain ? (
        <div className={`alert ${chain.ok ? "good" : "error"}`} role={chain.ok ? "status" : "alert"}>
          {chain.ok ? t("chainOk", { n: chain.checked }) : t("chainBad", { n: chain.broken_at })}
        </div>
      ) : (
        <div className="alert" role="status">
          {t("chainChecking")}
        </div>
      )}
      {error && <ErrorBox text={error} />}
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("when")}</th>
              <th scope="col">{t("who")}</th>
              <th scope="col">{t("whatHappenedShort")}</th>
              <th scope="col">{t("invoice")}</th>
              <th scope="col">{t("details")}</th>
              <th scope="col">{t("fingerprint")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event: any) => (
              <tr key={event.id}>
                <td className="nowrap muted">{dateTime(event.at)}</td>
                <td>
                  <span className={`actor ${event.actor}`}>{labels.actor[event.actor] || event.actor}</span>
                </td>
                <td>{labels.audit[event.action] || event.action.replaceAll("_", " ")}</td>
                <td>{event.invoice_id ? <a href={`#/invoices/${event.invoice_id}`}>{event.invoice_id}</a> : "-"}</td>
                <td className="small muted">{eventText(event.data, tools)}</td>
                <td className="mono small muted">{event.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextId && (
        <div className="button-row">
          <button disabled={loadingMore} aria-busy={loadingMore} onClick={loadMore}>
            {t("loadMore")}
          </button>
        </div>
      )}
    </>
  );
}
