import { useEffect, useRef, useState } from "react";

import { api, post } from "../api";
import { Key, useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, SectionCard } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import { Icon, IconName, IconTile } from "../ui/Icon";
import { Split } from "../ui/Layout";
import { Loading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { useToast } from "../ui/Toast";
import type { PageProps } from "../widgets/page";
import { RunAgentButton } from "../widgets/RunAgentButton";

const CUSTOMER_REQUEST = new Set(["plan_exception", "dispute_review", "payment_check"]);
const BUTTONS: Record<string, [Key, Key]> = {
  plan_exception: ["planYes", "planNo"],
  dispute_review: ["disputeYes", "disputeNo"],
  payment_check: ["paidYes", "paidNo"],
  owner_review: ["reviewYes", "notNow"],
};
const ICONS: Record<string, IconName> = {
  pre_due_note: "mail",
  friendly_reminder: "bell",
  firm_reminder: "bell-ring",
  final_notice: "octagon-x",
  owner_review: "user-check",
  plan_exception: "calendar-clock",
  dispute_review: "message-square",
  payment_check: "banknote",
};

function ApprovalCard({ item, position, total, done, later }: { item: any; position: number; total: number; done: (message: string) => void; later?: () => void }) {
  const { t, lang, labels, eur, daysLate } = useT();
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState<"" | "yes" | "no">("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const fromCustomer = CUSTOMER_REQUEST.has(item.action);
  const [yes, no] = BUTTONS[item.action] || (["approveSend", "notNow"] as [Key, Key]);
  const edited = body !== item.body;
  const customerLanguage = item.invoice.customer?.language === "en" ? "en" : "de";

  // Focus goes to the title, never to a button, so a stray key can't send the next message.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function decide(path: "approve" | "reject", payload?: unknown) {
    setBusy(path === "approve" ? "yes" : "no");
    setError("");
    try {
      const result = await post(`/api/approvals/${item.id}/${path}`, payload);
      done(result.message);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }

  const copy = lang === "de" ? item.german : item.english;
  const showCopy = !!copy && customerLanguage !== lang;

  return (
    <section className="card approval" aria-labelledby={`approval-${item.id}`}>
      <div className="card-head">
        <div className="card-title">
          <IconTile name={ICONS[item.action] || "inbox"} tone={fromCustomer ? "warn" : "info"} />
          <div className="card-title-text">
            {total > 1 && <span className="eyebrow">{t("oneOfMany", { current: position, total })}</span>}
            <h2 id={`approval-${item.id}`} ref={heading} tabIndex={-1}>
              {labels.action[item.action] || item.action}
            </h2>
          </div>
        </div>
        <Badge icon={item.decided_by_ai ? "sparkles" : "list-checks"}>{item.decided_by_ai ? t("byAi") : t("byRules")}</Badge>
      </div>
      <p className="approval-facts">
        <a href={`#/invoices/${item.invoice.id}`}>{item.invoice.number}</a>
        <span>{item.invoice.customer?.name}</span>
        <span>{t("openAmount", { amount: eur(item.invoice.open_cents) })}</span>
        {item.invoice.days_overdue > 0 && (
          <Badge tone="warn" icon="triangle-exclamation-point">
            {daysLate(item.invoice.days_overdue)}
          </Badge>
        )}
      </p>
      <Alert icon="lightbulb" title={t("why")}>
        {item.reason}
      </Alert>
      {fromCustomer ? (
        <blockquote className="quote" lang={customerLanguage}>
          <Icon name="message-square" size="sm" />
          <span>{item.body}</span>
        </blockquote>
      ) : (
        item.action !== "owner_review" && (
          <div className="mail-preview">
            <div className="mail-subject">
              <Icon name="mail" size="sm" />
              <span className="muted">{t("subject")}:</span>
              <strong>{item.subject}</strong>
            </div>
            <Field id={`message-${item.id}`} label={t("messageToCustomer", { subject: item.subject })} labelHidden="md" note={edited ? t("edited") : t("messageLanguage", { language: customerLanguage === "en" ? t("langEnglish") : t("langGerman") })}>
              <textarea rows={8} lang={customerLanguage} value={body} onChange={(event) => setBody(event.target.value)} />
            </Field>
            {showCopy && (
              <details>
                <summary>{lang === "de" ? t("readGerman") : t("readEnglish")}</summary>
                <p className="pre small">{copy}</p>
              </details>
            )}
          </div>
        )
      )}
      {error && <ErrorBox text={error} />}
      <div className="card-foot">
        {later && (
          <Button tone="ghost" disabled={!!busy} onClick={later}>
            {t("later_skip")}
          </Button>
        )}
        <Button disabled={!!busy} busy={busy === "no"} pending={t("working")} onClick={() => decide("reject")}>
          {t(no)}
        </Button>
        <Button tone="primary" icon={fromCustomer ? "check" : "send"} disabled={!!busy} busy={busy === "yes"} pending={t("sending")} onClick={() => decide("approve", edited ? { body } : {})}>
          {t(yes)}
        </Button>
      </div>
    </section>
  );
}

export function Approvals({ version, refresh }: PageProps) {
  const { t, labels, eur } = useT();
  const toast = useToast();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [currentId, setCurrentId] = useState<number | null>(null);

  useEffect(() => {
    api<any[]>("/api/approvals")
      .then((data) => {
        setRows(data);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [version, attempt]);

  if (error && !rows) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!rows) return <Loading shape="cards" title={t("approvals")} />;

  const currentIndex = Math.max(
    rows.findIndex((row) => row.id === currentId),
    0,
  );
  const current = rows[currentIndex];
  const others = rows.filter((row) => row !== current);

  return (
    <Page template="list">
      <PageHeader title={t("approvals")} info={t("approvalsIntro")} />
      <Split
        main={
          <>
            {rows.length === 0 && (
              <Card>
                <EmptyState icon="inbox" tone="good" title={t("nothingWaiting")} hint={t("nothingWaitingHint")} action={<RunAgentButton refresh={refresh} />} />
              </Card>
            )}
            {current && (
              <ApprovalCard
                key={current.id}
                item={current}
                position={currentIndex + 1}
                total={rows.length}
                done={(message) => {
                  toast(message);
                  setCurrentId(rows[currentIndex + 1]?.id ?? null);
                  refresh();
                }}
                later={rows.length > 1 ? () => setCurrentId(rows[(currentIndex + 1) % rows.length].id) : undefined}
              />
            )}
          </>
        }
        side={
          others.length > 0 && (
            <SectionCard title={t("alsoWaiting")} icon="inbox">
              <ul className="rows">
                {others.map((row) => (
                  <li className="row-item" key={row.id}>
                    <IconTile name={ICONS[row.action] || "inbox"} tone="neutral" size="sm" />
                    <div className="row-text">
                      <strong className="row-title">{labels.action[row.action] || row.action}</strong>
                      <span className="row-meta">
                        {row.invoice.customer?.name} · {eur(row.invoice.open_cents)}
                      </span>
                    </div>
                    <Button size="sm" tone="ghost" iconEnd="arrow-right" onClick={() => setCurrentId(row.id)}>
                      {t("bringForward")}
                    </Button>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )
        }
      />
    </Page>
  );
}
