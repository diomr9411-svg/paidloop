import { useEffect, useRef, useState } from "react";

import { api, post } from "../api";
import { Empty, ErrorBox, Field, Loading, useToast } from "../components";
import { Key, useT } from "../i18n";

const CUSTOMER_REQUEST = new Set(["plan_exception", "dispute_review", "payment_check"]);
const BUTTONS: Record<string, [Key, Key]> = {
  plan_exception: ["planYes", "planNo"],
  dispute_review: ["disputeYes", "disputeNo"],
  payment_check: ["paidYes", "paidNo"],
  owner_review: ["reviewYes", "notNow"],
};

function ApprovalCard({ item, position, total, done, later }: { item: any; position: number; total: number; done: (message: string) => void; later?: () => void }) {
  const { t, lang, labels, eur, daysLate } = useT();
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);
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

  const copy = lang === "de" ? item.german : item.english;
  const showCopy = !!copy && customerLanguage !== lang;

  return (
    <section className="card approval">
      <div className="title-row">
        <div>
          {total > 1 && <div className="muted small">{t("oneOfMany", { current: position, total })}</div>}
          <h2 ref={heading} tabIndex={-1}>
            {labels.action[item.action] || item.action}
          </h2>
        </div>
        <span className="chip">{item.decided_by_ai ? t("byAi") : t("byRules")}</span>
      </div>
      <p>
        <a href={`#/invoices/${item.invoice.id}`}>{item.invoice.number}</a>, {item.invoice.customer?.name}, {t("openAmount", { amount: eur(item.invoice.open_cents) })}
        {item.invoice.days_overdue > 0 ? `, ${daysLate(item.invoice.days_overdue)}` : ""}
      </p>
      <p className="why">
        <strong>{t("why")}</strong> {item.reason}
      </p>
      {fromCustomer ? (
        <blockquote lang={customerLanguage}>{item.body}</blockquote>
      ) : (
        item.action !== "owner_review" && (
          <>
            <Field
              id={`message-${item.id}`}
              label={t("messageToCustomer", { subject: item.subject })}
              hint={edited ? t("edited") : t("messageLanguage", { language: customerLanguage === "en" ? t("langEnglish") : t("langGerman") })}
            >
              <textarea rows={8} lang={customerLanguage} value={body} onChange={(event) => setBody(event.target.value)} />
            </Field>
            {showCopy && (
              <details>
                <summary>{lang === "de" ? t("readGerman") : t("readEnglish")}</summary>
                <p className="pre small">{copy}</p>
              </details>
            )}
          </>
        )
      )}
      {error && <ErrorBox text={error} />}
      <div className="button-row">
        <button className="primary" disabled={busy} aria-busy={busy} onClick={() => decide("approve", edited ? { body } : {})}>
          {t(yes)}
        </button>
        <button disabled={busy} onClick={() => decide("reject")}>
          {t(no)}
        </button>
        {later && (
          <button className="link" disabled={busy} onClick={later}>
            {t("later_skip")}
          </button>
        )}
      </div>
    </section>
  );
}

export function Approvals({ version, refresh }: { version: number; refresh: () => void }) {
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
  if (!rows) return <Loading />;

  const currentIndex = Math.max(rows.findIndex((row) => row.id === currentId), 0);
  const current = rows[currentIndex];
  const others = rows.filter((row) => row !== current);

  return (
    <>
      <h1>{t("approvals")}</h1>
      <p className="muted">{t("approvalsIntro")}</p>
      {rows.length === 0 && (
        <div className="card">
          <Empty title={t("nothingWaiting")} hint={t("nothingWaitingHint")} />
        </div>
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
      {others.length > 0 && (
        <section className="card">
          <h2>{t("alsoWaiting")}</h2>
          <ul className="queue">
            {others.map((row) => (
              <li key={row.id}>
                <div className="queue-text">
                  <strong>{labels.action[row.action] || row.action}</strong>
                  <span className="muted small">
                    {row.invoice.customer?.name} · {eur(row.invoice.open_cents)}
                  </span>
                </div>
                <button onClick={() => setCurrentId(row.id)}>{t("bringForward")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
