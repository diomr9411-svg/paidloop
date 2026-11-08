import { useEffect, useState } from "react";

import { api } from "../api";
import { useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Loading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { ActorBadge, eventText } from "../widgets/events";
import type { PageProps } from "../widgets/page";

export function Audit({ version }: PageProps) {
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
  if (!events) return <Loading shape="list" title={t("audit")} />;

  return (
    <Page template="list">
      <PageHeader title={t("audit")} info={t("auditIntro")} />
      {chain ? (
        <Alert tone={chain.ok ? "good" : "bad"} icon={chain.ok ? "shield-check" : "shield-x"} role={chain.ok ? "status" : "alert"}>
          {chain.ok ? t("chainOk", { n: chain.checked }) : t("chainBad", { n: chain.broken_at })}
        </Alert>
      ) : (
        <Alert icon="shield-check" role="status">
          {t("chainChecking")}
        </Alert>
      )}
      {error && <ErrorBox text={error} />}
      <section className="card flush" aria-label={t("audit")}>
        {events.length === 0 ? (
          <div className="card-pad">
            <EmptyState icon="list-checks" title={t("nothingYet")} />
          </div>
        ) : (
          <table className="rtable audit-table">
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
                  <td className="nowrap muted" data-label={t("when")}>
                    <time dateTime={event.at}>{dateTime(event.at)}</time>
                  </td>
                  <td data-label={t("who")}>
                    <ActorBadge actor={event.actor} />
                  </td>
                  <td className="lead" data-label={t("whatHappenedShort")}>
                    {labels.audit[event.action] || event.action.replaceAll("_", " ")}
                  </td>
                  <td className="nowrap" data-label={t("invoice")}>
                    {event.invoice_id ? <a href={`#/invoices/${event.invoice_id}`}>{t("invoiceRef", { id: event.invoice_id })}</a> : <span className="muted">-</span>}
                  </td>
                  <td className="small muted details-cell" data-label={t("details")}>
                    {eventText(event.data, tools)}
                  </td>
                  <td className="mono small muted" data-label={t("fingerprint")}>
                    {event.hash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {nextId && (
          <div className="list-foot">
            <Button icon="chevron-down" busy={loadingMore} pending={t("loading")} onClick={loadMore}>
              {t("loadMore")}
            </Button>
          </div>
        )}
      </section>
    </Page>
  );
}
