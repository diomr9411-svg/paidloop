import { useEffect, useState } from "react";

import { api } from "../api";
import { RunAgentButton } from "../App";
import { BarRows, Empty, ErrorBox, Loading } from "../components";
import { useT } from "../i18n";

function Tile({ label, value, note, tone, href }: { label: string; value: string; note: string; tone?: string; href?: string }) {
  const inner = (
    <>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-note">{note}</div>
    </>
  );
  return href ? (
    <a className={`card tile link-tile ${tone || ""}`} href={href}>
      {inner}
    </a>
  ) : (
    <div className={`card tile ${tone || ""}`}>{inner}</div>
  );
}

function Queue({ view, refresh }: { view: any; refresh: () => void }) {
  const { t, labels, eur, daysLate } = useT();
  return (
    <section className="card queue-card">
      <div className="title-row">
        <h2>{t("nextSteps")}</h2>
        <RunAgentButton refresh={refresh} small />
      </div>
      {view.queue.length === 0 ? (
        <Empty title={t("allDone")} hint={t("allDoneHint")} />
      ) : (
        <>
          <p className="muted small">{t("nextStepsHint")}</p>
          <ol className="queue">
            {view.queue.map((item: any, index: number) => {
              const href =
                item.kind === "approval" ? "#/approvals" : item.kind === "draft" ? `#/new?draft=${item.invoice_id}` : `#/invoices/${item.invoice_id}`;
              const button = item.kind === "approval" ? t("queueApproval") : item.kind === "draft" ? t("queueContinue") : t("queueOpen");
              const what = item.kind === "approval" ? labels.action[item.action] || item.action : item.kind === "draft" ? t("queueDraft") : t("queueNoReminder");
              return (
                <li key={`${item.kind}-${item.invoice_id}-${item.action}`}>
                  <div className="queue-text">
                    <strong>{what}</strong>
                    <span className="muted small">
                      {item.customer || t("draftUnnamed")}
                      {item.amount_cents ? ` · ${eur(item.amount_cents)}` : ""}
                      {item.days_late > 0 ? ` · ${daysLate(item.days_late)}` : ""}
                    </span>
                  </div>
                  <a className={`button ${index === 0 ? "primary" : ""}`} href={href}>
                    {button}
                  </a>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export function Dashboard({ version, refresh }: { version: number; refresh: () => void }) {
  const { t, eur, day, invoiceCount } = useT();
  const [view, setView] = useState<any>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/dashboard")
        .then((data) => {
          if (!alive) return;
          setView(data);
          setError("");
        })
        .catch((e) => alive && setError(e.message));
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [version, attempt]);

  if (error && !view) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!view) return <Loading />;

  const empty = view.open_count === 0 && view.paid_count === 0 && view.queue.length === 0;
  const results = view.performance;
  return (
    <>
      <div className="title-row">
        <h1>{t("homeTitle")}</h1>
        <a className="button primary" href="#/new">
          {t("newInvoice")}
        </a>
      </div>
      {error && <ErrorBox text={error} />}
      {empty && (
        <div className="card callout">
          <strong>{t("emptyStart")}</strong> <a href="#/new">{t("emptyStartLink")}</a> {t("emptyStartRest")}
        </div>
      )}

      <div className="columns home-top">
        <div className="hero card">
          <div className="tile-label">{t("spendable")}</div>
          <div className={`hero-value ${view.spendable_cents < 0 ? "negative" : ""}`}>{eur(view.spendable_cents)}</div>
          <div className="tile-note">
            {t("spendableNote", { cash: eur(view.cash_cents), vat: eur(view.vat_due_cents) })}
            {view.vat_on_unpaid_cents > 0 && ` ${t("spendableSoll", { vat: eur(view.vat_on_unpaid_cents) })}`}
          </div>
        </div>
        <Queue view={view} refresh={refresh} />
      </div>

      <div className="tiles">
        <Tile label={t("waitingToBePaid")} value={eur(view.open_cents)} note={invoiceCount(view.open_count)} href="#/invoices?filter=open" />
        <Tile
          label={t("overdue")}
          value={eur(view.overdue_cents)}
          note={invoiceCount(view.overdue_count)}
          tone={view.overdue_count ? "warn" : ""}
          href="#/invoices?filter=overdue"
        />
        <Tile label={t("onPlanTile")} value={eur(view.on_plan_cents)} note={t("onPlanNote")} href="#/invoices?filter=on_plan" />
        <Tile label={t("onHoldTile")} value={eur(view.disputed_cents)} note={t("onHoldNote")} href="#/invoices?filter=disputed" />
      </div>

      <div className="columns">
        <section className="card">
          <h2>{t("whenMoney")}</h2>
          <p className="muted small">{t("whenMoneyHint")}</p>
          <BarRows
            label={t("moneyByDate")}
            rows={[
              { key: "week", label: t("next7"), cents: view.forecast.week, hint: t("next7Hint") },
              { key: "month", label: t("next30"), cents: view.forecast.month, hint: t("next30Hint") },
              { key: "later", label: t("later"), cents: view.forecast.later, hint: t("laterHint") },
              { key: "risk", label: t("atRisk"), cents: view.forecast.at_risk, risk: true, hint: t("atRiskHint") },
            ]}
          />
        </section>
        <section className="card">
          <h2>{t("howLate")}</h2>
          <p className="muted small">{t("howLateHint")}</p>
          <BarRows
            label={t("moneyByAge")}
            rows={[
              { key: "not_due", label: t("ageNotDue"), cents: view.aging.not_due, hint: t("ageNotDue") },
              { key: "d1", label: t("age1"), cents: view.aging.days_1_30, hint: t("age1") },
              { key: "d31", label: t("age31"), cents: view.aging.days_31_60, hint: t("age31") },
              { key: "d61", label: t("age61"), cents: view.aging.days_61_plus, risk: true, hint: t("age61") },
            ]}
          />
        </section>
      </div>

      <div className="columns">
        <section className="card">
          <h2>{t("howWell")}</h2>
          <p className="muted small">{t("howWellHint")}</p>
          <dl className="measures">
            <div>
              <dt>{t("avgDaysToPaid")}</dt>
              <dd>{results.avg_days_to_paid === null ? t("noData") : t("avgDaysValue", { n: results.avg_days_to_paid })}</dd>
              {results.paid_count > 0 && <dd className="muted small">{t("basedOnPaid", { n: results.paid_count })}</dd>}
            </div>
            <div>
              <dt>{t("onTimeRate")}</dt>
              <dd>{results.on_time_percent === null ? t("noData") : `${results.on_time_percent} %`}</dd>
              {results.paid_count > 0 && <dd className="muted small">{t("basedOnPaid", { n: results.paid_count })}</dd>}
            </div>
            <div>
              <dt>{t("noteToIssued")}</dt>
              <dd>{results.avg_seconds_to_issue === null ? t("noData") : formatSeconds(results.avg_seconds_to_issue, t)}</dd>
              {results.timed_invoices > 0 && <dd className="muted small">{t("basedOnTimed", { n: results.timed_invoices })}</dd>}
            </div>
          </dl>
        </section>
        <section className="card">
          <h2>{t("nextExpected")}</h2>
          {view.upcoming.length === 0 ? (
            <p className="muted">{t("noOpenPayments")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("expected")}</th>
                  <th scope="col">{t("customer")}</th>
                  <th scope="col" className="num">
                    {t("amount")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.upcoming.map((item: any, index: number) => (
                  <tr key={index}>
                    <td className="nowrap">{day(item.expected_on)}</td>
                    <td>
                      <a href={`#/invoices/${item.invoice_id}`}>{item.customer}</a>
                      {item.risk === "high" && <span className="pill warn small-pill">! {t("highRisk")}</span>}
                    </td>
                    <td className="num">{eur(item.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <p className="muted small">{view.ledger_balanced ? t("ledgerOk") : t("ledgerBad")}</p>
    </>
  );
}

function formatSeconds(seconds: number, t: ReturnType<typeof useT>["t"]) {
  return seconds < 120 ? t("seconds", { n: seconds }) : t("minutes", { n: Math.round(seconds / 60) });
}
