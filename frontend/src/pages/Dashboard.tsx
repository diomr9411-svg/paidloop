import { useEffect, useState } from "react";

import { api } from "../api";
import { useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { BarRows } from "../ui/BarRows";
import { ButtonLink } from "../ui/Button";
import { Card, SectionCard } from "../ui/Card";
import { cx } from "../ui/cx";
import { EmptyState } from "../ui/EmptyState";
import { Icon, IconName, IconTile, Tone } from "../ui/Icon";
import { Loading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { StatTile } from "../ui/StatTile";
import { Badge } from "../ui/Badge";
import type { PageProps } from "../widgets/page";
import { RunAgentButton } from "../widgets/RunAgentButton";

type QueueItem = { kind: "approval" | "draft" | "no_reminder_yet"; invoice_id: number; action: string; customer: string | null; amount_cents: number; days_late: number };

const KIND: Record<QueueItem["kind"], { icon: IconName; tone: Tone }> = {
  approval: { icon: "inbox", tone: "info" },
  draft: { icon: "file-pen", tone: "neutral" },
  no_reminder_yet: { icon: "bell", tone: "warn" },
};

function NextSteps({ queue, refresh }: { queue: QueueItem[]; refresh: () => void }) {
  const { t, labels, eur, daysLate } = useT();
  return (
    <SectionCard title={t("nextSteps")} subtitle={queue.length ? t("nextStepsHint") : undefined} actions={<RunAgentButton refresh={refresh} size="sm" />} className="next-steps">
      {queue.length === 0 ? (
        <EmptyState icon="circle-check" tone="good" title={t("allDone")} hint={t("allDoneHint")} />
      ) : (
        <ol className="rows">
          {queue.map((item) => {
            const href = item.kind === "approval" ? "#/approvals" : item.kind === "draft" ? `#/new?draft=${item.invoice_id}` : `#/invoices/${item.invoice_id}`;
            const button = item.kind === "approval" ? t("queueApproval") : item.kind === "draft" ? t("queueContinue") : t("queueOpen");
            const what = item.kind === "approval" ? labels.action[item.action] || item.action : item.kind === "draft" ? t("queueDraft") : t("queueNoReminder");
            const kind = KIND[item.kind] || KIND.no_reminder_yet;
            return (
              <li className="row-item" key={`${item.kind}-${item.invoice_id}-${item.action}`}>
                <IconTile name={kind.icon} tone={kind.tone} size="sm" />
                <div className="row-text">
                  <strong className="row-title">{what}</strong>
                  <span className="row-meta">
                    {item.customer || t("draftUnnamed")}
                    {item.amount_cents ? ` · ${eur(item.amount_cents)}` : ""}
                    {item.days_late > 0 ? ` · ${daysLate(item.days_late)}` : ""}
                  </span>
                </div>
                <ButtonLink size="sm" tone="ghost" iconEnd="arrow-right" href={href}>
                  {button}
                </ButtonLink>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

export function Dashboard({ version, refresh, health }: PageProps) {
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
  if (!view) return <Loading shape="dashboard" title={t("homeTitle")} />;

  const empty = view.open_count === 0 && view.paid_count === 0 && view.queue.length === 0;
  const results = view.performance;
  const negative = view.spendable_cents < 0;
  return (
    <Page template="dashboard">
      <PageHeader
        title={t("homeTitle")}
        actions={
          <ButtonLink tone="primary" icon="file-plus" href="#/new">
            {t("newInvoice")}
          </ButtonLink>
        }
      />
      {error && <ErrorBox text={error} />}
      {health?.paypal_mode === "simulated" && (
        <Alert
          tone="warn"
          icon="plug"
          title={t("connectPaypal")}
          action={
            <ButtonLink size="sm" href="#/settings/connections" iconEnd="arrow-right">
              {t("connectPaypal")}
            </ButtonLink>
          }
        >
          {t("connectPaypalHint")}
        </Alert>
      )}
      {empty && (
        <Card>
          <EmptyState
            icon="receipt-text"
            title={t("emptyStart")}
            hint={t("emptyStartHint")}
            action={
              <ButtonLink tone="primary" icon="file-plus" href="#/new">
                {t("emptyStartLink")}
              </ButtonLink>
            }
          />
        </Card>
      )}

      <div className="home-top">
        <section className="card hero" aria-labelledby="spendable-label">
          <div className="hero-head">
            <span className="stat-label" id="spendable-label">
              {t("spendable")}
            </span>
            <IconTile name="wallet" />
          </div>
          <p className={cx("hero-value", negative && "negative")}>{eur(view.spendable_cents)}</p>
          <dl className="hero-facts">
            <div>
              <dt>{t("received")}</dt>
              <dd>{eur(view.cash_cents)}</dd>
            </div>
            <div>
              <dt>{t("vatForTaxOffice")}</dt>
              <dd>{eur(-view.vat_due_cents)}</dd>
            </div>
          </dl>
          {negative && (
            <p className="hero-note warn">
              <Icon name="triangle-exclamation-point" size="sm" />
              {t("spendableNegative")}
            </p>
          )}
          {view.vat_on_unpaid_cents > 0 && <p className="hero-note">{t("spendableSoll", { vat: eur(view.vat_on_unpaid_cents) })}</p>}
        </section>
        <NextSteps queue={view.queue} refresh={refresh} />
      </div>

      <div className="tiles">
        <StatTile label={t("waitingToBePaid")} value={eur(view.open_cents)} note={invoiceCount(view.open_count)} icon="hourglass" href="#/invoices?filter=open" />
        <StatTile
          label={t("overdue")}
          value={eur(view.overdue_cents)}
          note={invoiceCount(view.overdue_count)}
          icon="triangle-exclamation-point"
          tone={view.overdue_count ? "warn" : "info"}
          href="#/invoices?filter=overdue"
        />
        <StatTile label={t("onPlanTile")} value={eur(view.on_plan_cents)} note={t("onPlanNote")} icon="calendar-clock" href="#/invoices?filter=on_plan" />
        <StatTile label={t("onHoldTile")} value={eur(view.disputed_cents)} note={t("onHoldNote")} icon="circle-pause" href="#/invoices?filter=disputed" />
      </div>

      <div className="columns">
        <SectionCard title={t("whenMoney")} subtitle={t("whenMoneyHint")} icon="calendar">
          <BarRows
            label={t("moneyByDate")}
            rows={[
              { key: "week", label: t("next7"), value: view.forecast.week, display: eur(view.forecast.week), hint: t("next7Hint") },
              { key: "month", label: t("next30"), value: view.forecast.month, display: eur(view.forecast.month), hint: t("next30Hint") },
              { key: "later", label: t("later"), value: view.forecast.later, display: eur(view.forecast.later), hint: t("laterHint") },
              { key: "risk", label: t("atRisk"), value: view.forecast.at_risk, display: eur(view.forecast.at_risk), hint: t("atRiskHint"), risk: true },
            ]}
          />
        </SectionCard>
        <SectionCard title={t("howLate")} subtitle={t("howLateHint")} icon="clock">
          <BarRows
            label={t("moneyByAge")}
            rows={[
              { key: "not_due", label: t("ageNotDue"), value: view.aging.not_due, display: eur(view.aging.not_due), hint: t("ageNotDueHint") },
              { key: "d1", label: t("age1"), value: view.aging.days_1_30, display: eur(view.aging.days_1_30), hint: t("age1Hint") },
              { key: "d31", label: t("age31"), value: view.aging.days_31_60, display: eur(view.aging.days_31_60), hint: t("age31Hint") },
              { key: "d61", label: t("age61"), value: view.aging.days_61_plus, display: eur(view.aging.days_61_plus), hint: t("age61Hint"), risk: true },
            ]}
          />
        </SectionCard>
      </div>

      <div className="columns">
        <SectionCard title={t("howWell")} subtitle={t("howWellHint")} icon="gauge">
          <dl className="measures">
            <div>
              <dt>{t("avgDaysToPaid")}</dt>
              <dd className="measure-value">{results.avg_days_to_paid === null ? t("noData") : t("avgDaysValue", { n: results.avg_days_to_paid })}</dd>
              {results.paid_count > 0 && <dd className="measure-note">{t("basedOnPaid", { n: results.paid_count })}</dd>}
            </div>
            <div>
              <dt>{t("onTimeRate")}</dt>
              <dd className="measure-value">{results.on_time_percent === null ? t("noData") : `${results.on_time_percent} %`}</dd>
              {results.paid_count > 0 && <dd className="measure-note">{t("basedOnPaid", { n: results.paid_count })}</dd>}
            </div>
            <div>
              <dt>{t("noteToIssued")}</dt>
              <dd className="measure-value">{results.avg_seconds_to_issue === null ? t("noData") : formatSeconds(results.avg_seconds_to_issue, t)}</dd>
              {results.timed_invoices > 0 && <dd className="measure-note">{t("basedOnTimed", { n: results.timed_invoices })}</dd>}
            </div>
          </dl>
        </SectionCard>
        <SectionCard title={t("nextExpected")} icon="calendar-clock" flush>
          {view.upcoming.length === 0 ? (
            <div className="card-pad">
              <EmptyState icon="calendar" title={t("noOpenPayments")} />
            </div>
          ) : (
            <table className="rtable">
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
                {view.upcoming.map((item: any) => (
                  <tr key={`${item.invoice_id}-${item.expected_on}`}>
                    <td className="nowrap" data-label={t("expected")}>
                      {day(item.expected_on)}
                    </td>
                    <td className="lead" data-label={t("customer")}>
                      <span className="cell-line">
                        <a href={`#/invoices/${item.invoice_id}`}>{item.customer}</a>
                        {item.risk === "high" && (
                          <Badge tone="warn" icon="triangle-exclamation-point">
                            {t("highRisk")}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="num" data-label={t("amount")}>
                      {eur(item.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      </div>
      <p className={cx("status-line", view.ledger_balanced ? "good" : "bad")}>
        <Icon name={view.ledger_balanced ? "circle-check" : "circle-exclamation-point"} size="sm" />
        {view.ledger_balanced ? t("ledgerOk") : t("ledgerBad")}
      </p>
    </Page>
  );
}

function formatSeconds(seconds: number, t: ReturnType<typeof useT>["t"]) {
  return seconds < 120 ? t("seconds", { n: seconds }) : t("minutes", { n: Math.round(seconds / 60) });
}
