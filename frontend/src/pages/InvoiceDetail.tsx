import { useEffect, useState } from "react";

import { api, customerLink, del, post, toNumber } from "../api";
import { ErrorBox, Field, Loading, PageHeader, StatusPill, TwoStepButton, useCopyLink, useToast } from "../components";
import { useT } from "../i18n";
import { eventText } from "./Audit";

export function InvoiceDetail({ id, version, refresh }: { id: number; version: number; refresh: () => void }) {
  const tools = useT();
  const { t, lang, labels, eur, day, dateTime, daysLate } = tools;
  const toast = useToast();
  const copyLink = useCopyLink();
  const [invoice, setInvoice] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bank, setBank] = useState("");
  const [bankError, setBankError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [interval, setIntervalSeconds] = useState(20);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api(`/api/invoices/${id}`)
        .then((data) => {
          if (!alive) return;
          setInvoice(data);
          setError("");
        })
        .catch((e) => alive && setError(e.message));
      api(`/api/audit?invoice_id=${id}&limit=50`).then((data) => alive && setEvents(data.events)).catch(() => undefined);
    };
    load();
    api("/api/health").then((data) => alive && setIntervalSeconds(data.sync?.interval_seconds || 20)).catch(() => undefined);
    const timer = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id, version, attempt]);

  async function act(action: () => Promise<any>, success: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      setInvoice(await action());
      toast(success);
      refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (error && !invoice) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!invoice) return <Loading shape="detail" title={t("allInvoices")} />;

  const isDraft = invoice.status === "draft" || invoice.status === "checked";
  const open = ["issued", "on_plan", "disputed"].includes(invoice.status);
  const late = open && invoice.days_overdue > 0 && invoice.status !== "disputed";

  let now = "";
  if (isDraft) now = t("nowDraft");
  else if (invoice.status === "paid") now = t("nowPaid");
  else if (invoice.status === "cancelled") now = t("nowCancelled");
  else if (invoice.status === "disputed") now = t("nowHold");
  else if (late) now = t("nowOverdue", { late: daysLate(invoice.days_overdue) });
  else if (invoice.status === "on_plan") now = t("nowPlan");
  else now = t("nowOpen", { date: day(invoice.due_date), seconds: interval });

  return (
    <>
      <PageHeader
        title={invoice.number || t("draftNumber", { id: invoice.id })}
        back={{ href: "#/invoices", label: t("allInvoices") }}
        actions={<StatusPill status={invoice.status} overdue={invoice.days_overdue} />}
      />
      {error && <ErrorBox text={error} />}

      <div className={`card now ${invoice.has_pending || late ? "attention" : ""}`}>
        <div>
          {now}
          {invoice.has_pending && <strong> {t("nowWaiting")}</strong>}
        </div>
        <div className="button-row tight">
          {invoice.has_pending && (
            <a className="button primary" href="#/approvals">
              {t("openApprovals")}
            </a>
          )}
          {isDraft && (
            <>
              <a className="button primary" href={`#/new?draft=${invoice.id}`}>
                {t("continueDraft")}
              </a>
              <TwoStepButton
                label={t("deleteDraft")}
                confirmLabel={t("deleteConfirm")}
                disabled={busy}
                onConfirm={async () => {
                  setBusy(true);
                  try {
                    await del(`/api/invoices/${id}`);
                    toast(t("draftDeleted"));
                    refresh();
                    window.location.hash = "#/invoices";
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              />
            </>
          )}
        </div>
      </div>

      <div className="stack">
        <section className="card">
          <h2>{invoice.customer?.name}</h2>
          <p className="muted">
            {invoice.customer?.is_business ? t("businessCustomer") : t("privateCustomer")}
            {invoice.customer?.city ? `, ${invoice.customer.city}` : ""}
            {invoice.customer ? ` · ${invoice.customer.language === "en" ? t("langEnglish") : t("langGerman")}` : ""}
          </p>
          <table className="rtable">
            <thead>
              <tr>
                <th scope="col">{t("item")}</th>
                <th scope="col" className="num">
                  {t("qty")}
                </th>
                <th scope="col" className="num">
                  {t("price")}
                </th>
                <th scope="col" className="num">
                  {t("net")}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line: any, index: number) => (
                <tr key={index}>
                  <td className="lead" data-label={t("item")}>
                    {line.description}
                  </td>
                  <td className="num" data-label={t("qty")}>
                    {new Intl.NumberFormat(lang === "de" ? "de-DE" : "en-GB").format(line.quantity)} {line.unit === "HUR" ? t("unitHours") : ""}
                  </td>
                  <td className="num" data-label={t("price")}>
                    {eur(line.unit_price_cents)}
                  </td>
                  <td className="num" data-label={t("net")}>
                    {eur(line.net_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>{t("net")}</td>
                <td className="num">{eur(invoice.net_cents)}</td>
              </tr>
              <tr>
                <td colSpan={3}>{t("vat")}</td>
                <td className="num">{eur(invoice.vat_cents)}</td>
              </tr>
              <tr className="total">
                <td colSpan={3}>{t("total")}</td>
                <td className="num">{eur(invoice.gross_cents)}</td>
              </tr>
              {!isDraft && (
                <>
                  <tr>
                    <td colSpan={3}>{t("paid")}</td>
                    <td className="num">{eur(invoice.paid_cents)}</td>
                  </tr>
                  <tr className="total">
                    <td colSpan={3}>{t("stillOpen")}</td>
                    <td className="num">{eur(invoice.open_cents)}</td>
                  </tr>
                </>
              )}
            </tfoot>
          </table>
          <dl className="facts">
            <dt>{t("invoiceDate")}</dt>
            <dd>{day(invoice.issue_date)}</dd>
            <dt>{t("workDate")}</dt>
            <dd>{day(invoice.service_date)}</dd>
            <dt>{t("due")}</dt>
            <dd>{day(invoice.due_date)}</dd>
          </dl>
          {invoice.source_text && (
            <details>
              <summary>{t("sourceNote")}</summary>
              <p className="pre small">{invoice.source_text}</p>
            </details>
          )}
        </section>

        <section className="stack">
          {!isDraft && (
            <div className="card">
              <h2>{t("documents")}</h2>
              <div className="button-row">
                <a className="button" href={`/api/invoices/${id}/pdf`}>
                  {t("downloadPdf")}
                </a>
                <a className="button" href={`/api/invoices/${id}/xml`}>
                  {t("xml")}
                </a>
                {invoice.credit_note_number && (
                  <a className="button" href={`/api/invoices/${id}/credit-note`}>
                    {t("creditNote", { number: invoice.credit_note_number })}
                  </a>
                )}
                {invoice.pay_link && !invoice.plan && invoice.status !== "cancelled" && (
                  <a className="button" href={invoice.pay_link} target="_blank" rel="noreferrer">
                    {t("paypalLink")}
                  </a>
                )}
                {invoice.public_token && (
                  <>
                    <a className="button primary" href={`#/pay/${invoice.public_token}`} target="_blank" rel="noreferrer">
                      {t("customerPage")}
                    </a>
                    <button onClick={() => copyLink(customerLink(invoice.public_token))}>{t("copyLink")}</button>
                  </>
                )}
              </div>
              <p className="muted small">{t("documentsHint")}</p>
            </div>
          )}

          {invoice.risk && open && (
            <div className="card">
              <h2>
                {t("paymentRisk")}: {invoice.risk.level === "high" ? `! ${t("riskHigh")}` : invoice.risk.level === "medium" ? t("riskMedium") : t("riskLow")}
              </h2>
              <ul className="plain">
                {invoice.risk.reasons.map((reason: string) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {invoice.late_costs?.in_default && (
                <p className="small">
                  {t(invoice.late_costs.flat_fee_cents ? "inDefaultFee" : "inDefault", {
                    date: day(invoice.late_costs.default_since),
                    interest: eur(invoice.late_costs.interest_cents),
                    rate: lang === "de" ? String(invoice.late_costs.rate_percent).replace(".", ",") : invoice.late_costs.rate_percent,
                    fee: eur(invoice.late_costs.flat_fee_cents),
                  })}
                </p>
              )}
            </div>
          )}

          {invoice.plan && (
            <div className="card">
              <h2>{t("paymentPlan")}</h2>
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t("due")}</th>
                    <th scope="col" className="num">
                      {t("amount")}
                    </th>
                    <th scope="col">{t("status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.plan.installments.map((item: any) => (
                    <tr key={item.seq}>
                      <td className="lead" data-label="#">
                        {item.seq}
                      </td>
                      <td className="nowrap" data-label={t("due")}>
                        {day(item.due_date)}
                      </td>
                      <td className="num" data-label={t("amount")}>
                        {eur(item.amount_cents)}
                      </td>
                      <td data-label={t("status")}>{item.is_paid ? t("planPaid") : t("planOpen")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {open && (
            <div className="card">
              <h2>{t("otherActions")}</h2>
              {invoice.status !== "on_plan" && (
                <div className="inline-form">
                  <Field id="bank-payment" label={t("bankPayment")} error={bankError}>
                    <input
                      value={bank}
                      inputMode="decimal"
                      placeholder={(invoice.open_cents / 100).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { minimumFractionDigits: 2 })}
                      onChange={(event) => {
                        setBank(event.target.value);
                        setBankError("");
                      }}
                    />
                  </Field>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      const amount = bank.trim() ? toNumber(bank, lang) : invoice.open_cents / 100;
                      if (!(amount > 0)) {
                        setBankError(t("amountAboveZero"));
                        return;
                      }
                      const done = await act(() => post(`/api/invoices/${id}/record-payment`, { amount_eur: amount }), t("paymentRecorded"));
                      if (done) setBank("");
                    }}
                  >
                    {t("recordPayment")}
                  </button>
                </div>
              )}
              {invoice.paid_cents === 0 && (
                <div className="button-row">
                  <TwoStepButton
                    label={t("cancelInvoice")}
                    confirmLabel={t("cancelConfirm")}
                    hint={t("cancelHint")}
                    disabled={busy}
                    onConfirm={() => act(() => post(`/api/invoices/${id}/cancel`, { reason: t("cancelReason") }), t("cancelled"))}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {invoice.messages.length > 0 && (
        <section className="card">
          <h2>{t("chatWithCustomer")}</h2>
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
        <h2>{t("whatHappened")}</h2>
        {events.length === 0 ? (
          <p className="muted">{t("nothingYet")}</p>
        ) : (
          <div className="table-scroll">
            <table className="rtable">
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="nowrap muted" data-label={t("when")}>
                      {dateTime(event.at)}
                    </td>
                    <td data-label={t("who")}>
                      <span className={`actor ${event.actor}`}>{labels.actor[event.actor] || event.actor}</span>
                    </td>
                    <td className="lead" data-label={t("whatHappenedShort")}>
                      {labels.audit[event.action] || event.action.replaceAll("_", " ")}
                    </td>
                    <td className="muted small" data-label={t("details")}>
                      {eventText(event.data, tools)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
