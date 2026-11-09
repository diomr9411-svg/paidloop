import { ReactNode, useEffect, useState } from "react";

import { api, customerLink, del, post, toNumber } from "../api";
import { useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { ConfirmButton } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import type { IconName, Tone } from "../ui/Icon";
import { Split } from "../ui/Layout";
import { Loading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { useToast } from "../ui/Toast";
import { useCopyLink } from "../widgets/copyLink";
import { ActorBadge, eventText } from "../widgets/events";
import type { PageProps } from "../widgets/page";
import { StatusBadge } from "../widgets/StatusBadge";

export function InvoiceDetail({ param, version, refresh, health }: PageProps) {
  const id = Number(param);
  const tools = useT();
  const { t, lang, labels, eur, day, dateTime, daysLate } = tools;
  const toast = useToast();
  const copyLink = useCopyLink();
  const [invoice, setInvoice] = useState<any>(null);
  const [business, setBusiness] = useState<any>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bank, setBank] = useState("");
  const [bankError, setBankError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const interval = health?.sync?.interval_seconds || 20;

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
      api(`/api/audit?invoice_id=${id}&limit=50`)
        .then((data) => alive && setEvents(data.events))
        .catch(() => alive && setEvents([]));
    };
    load();
    api("/api/business")
      .then((data) => alive && setBusiness(data))
      .catch(() => undefined);
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
  const title = invoice.number || t("draftNumber", { id: invoice.id });
  const number = (value: number) => new Intl.NumberFormat(lang === "de" ? "de-DE" : "en-GB").format(value);

  let now: { text: string; tone: Tone; icon: IconName };
  if (isDraft) now = { text: t("nowDraft"), tone: "neutral", icon: "file-pen" };
  else if (invoice.status === "paid") now = { text: t("nowPaid"), tone: "good", icon: "circle-check" };
  else if (invoice.status === "cancelled") now = { text: t("nowCancelled"), tone: "neutral", icon: "ban" };
  else if (invoice.status === "disputed") now = { text: t("nowHold"), tone: "warn", icon: "circle-pause" };
  else if (late) now = { text: t("nowOverdue", { late: daysLate(invoice.days_overdue) }), tone: "warn", icon: "triangle-exclamation-point" };
  else if (invoice.status === "on_plan") now = { text: t("nowPlan"), tone: "info", icon: "calendar-clock" };
  else now = { text: t("nowOpen", { date: day(invoice.due_date), seconds: interval }), tone: "info", icon: "hourglass" };

  let nextStep: ReactNode = null;
  if (invoice.has_pending)
    nextStep = (
      <ButtonLink tone="primary" size="sm" icon="inbox" href="#/approvals">
        {t("openApprovals")}
      </ButtonLink>
    );
  else if (isDraft)
    nextStep = (
      <div className="button-row">
        <ButtonLink tone="primary" size="sm" icon="pencil" href={`#/new?draft=${invoice.id}`}>
          {t("continueDraft")}
        </ButtonLink>
        <ConfirmButton
          size="sm"
          icon="trash"
          label={t("deleteDraft")}
          title={t("deleteTitle")}
          body={t("deleteBody")}
          confirmLabel={t("deleteConfirm")}
          disabled={busy}
          onConfirm={async () => {
            try {
              await del(`/api/invoices/${id}`);
              toast(t("draftDeleted"));
              refresh();
              window.location.hash = "#/invoices";
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </div>
    );

  const customer = invoice.customer;
  return (
    <Page template="detail">
      <PageHeader
        title={title}
        back={{ href: "#/invoices", label: t("allInvoices") }}
        meta={<StatusBadge status={invoice.status} overdue={invoice.days_overdue} />}
        actions={
          !isDraft && (
            <>
              <ButtonLink icon="download" href={`/api/invoices/${id}/pdf`}>
                {t("downloadPdf")}
              </ButtonLink>
              {invoice.public_token && (
                <Button tone="primary" icon="copy" onClick={() => copyLink(customerLink(invoice.public_token))}>
                  {t("copyLink")}
                </Button>
              )}
            </>
          )
        }
      />
      {error && <ErrorBox text={error} />}

      <Alert tone={now.tone} icon={now.icon} title={now.text} action={nextStep} role="status">
        {invoice.has_pending ? t("nowWaiting") : null}
      </Alert>

      <Split
        main={
          <>
            <article className="paper" aria-label={t("invoiceFace")}>
              <header className="paper-head">
                <div className="paper-block">
                  <strong className="paper-seller">{business?.name || " "}</strong>
                  {business && (
                    <span className="muted">
                      {[business.street, [business.postcode, business.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                    </span>
                  )}
                  {business?.vat_id && <span className="muted small">{t("vatIdShort", { id: business.vat_id })}</span>}
                </div>
                <div className="paper-title">
                  <span className="eyebrow">{t("invoiceWord")}</span>
                  <strong className="paper-number">{title}</strong>
                </div>
              </header>

              <div className="paper-parties">
                <div className="paper-block">
                  <span className="eyebrow">{t("billTo")}</span>
                  <strong>{customer?.name || t("draftUnnamed")}</strong>
                  {customer && (
                    <>
                      {customer.street && <span>{customer.street}</span>}
                      {(customer.postcode || customer.city) && <span>{[customer.postcode, customer.city].filter(Boolean).join(" ")}</span>}
                      <span className="muted small">
                        {customer.is_business ? t("businessCustomer") : t("privateCustomer")} · {customer.language === "en" ? t("langEnglish") : t("langGerman")}
                      </span>
                    </>
                  )}
                </div>
                <dl className="facts paper-dates">
                  <dt>{t("invoiceDate")}</dt>
                  <dd>{day(invoice.issue_date)}</dd>
                  <dt>{t("workDate")}</dt>
                  <dd>{day(invoice.service_date)}</dd>
                  <dt>{t("due")}</dt>
                  <dd>{day(invoice.due_date)}</dd>
                </dl>
              </div>

              <table className="rtable paper-lines">
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
                      <td className="lead" data-label="">
                        {line.description}
                      </td>
                      <td className="num" data-label={t("qty")}>
                        {number(line.quantity)} {line.unit === "HUR" ? t("unitHours") : ""}
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
              </table>

              <dl className="paper-totals">
                <dt>{t("net")}</dt>
                <dd>{eur(invoice.net_cents)}</dd>
                <dt>{t("vat")}</dt>
                <dd>{eur(invoice.vat_cents)}</dd>
                <dt className="grand">{t("total")}</dt>
                <dd className="grand">{eur(invoice.gross_cents)}</dd>
                {!isDraft && (
                  <>
                    <dt>{t("paid")}</dt>
                    <dd>{eur(-invoice.paid_cents)}</dd>
                    <dt className="grand">{t("stillOpen")}</dt>
                    <dd className="grand">{eur(invoice.open_cents)}</dd>
                  </>
                )}
              </dl>

              {invoice.payments?.length > 0 && (
                <div className="paper-payments">
                  <span className="eyebrow">{t("paymentsReceived")}</span>
                  <ul className="rows">
                    {invoice.payments.map((payment: any, index: number) => (
                      <li className="row-item compact" key={index}>
                        <span className="muted nowrap">{day(payment.paid_on)}</span>
                        <span>{methodName(payment.method, t)}</span>
                        <strong className="num">{eur(payment.amount_cents)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!isDraft && <p className="paper-foot">{t("documentsHint")}</p>}
            </article>
            {invoice.messages.length > 0 && (
              <SectionCard title={t("chatWithCustomer")} icon="message-square">
                <div className="chat readonly">
                  {invoice.messages.map((message: any, index: number) => (
                    <div key={index} className={`bubble ${message.role}`}>
                      {message.text}
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}
          </>
        }
        side={
          <>

            {!isDraft && (
              <SectionCard title={t("documents")} icon="file-text">
                <div className="button-row">
                  <ButtonLink icon="file-code" href={`/api/invoices/${id}/xml`}>
                    {t("xml")}
                  </ButtonLink>
                  {invoice.credit_note_number && (
                    <ButtonLink icon="file-text" href={`/api/invoices/${id}/credit-note`}>
                      {t("creditNote", { number: invoice.credit_note_number })}
                    </ButtonLink>
                  )}
                  {invoice.pay_link && !invoice.plan && invoice.status !== "cancelled" && (
                    <ButtonLink icon="credit-card" href={invoice.pay_link} external>
                      {t("paypalLink")}
                    </ButtonLink>
                  )}
                  {invoice.public_token && (
                    <ButtonLink icon="link" href={`#/pay/${invoice.public_token}`} external>
                      {t("customerPage")}
                    </ButtonLink>
                  )}
                </div>
                {invoice.source_text && (
                  <details className="source-note">
                    <summary>{t("sourceNote")}</summary>
                    <p className="pre small">{invoice.source_text}</p>
                  </details>
                )}
              </SectionCard>
            )}

            {invoice.plan && (
              <SectionCard title={t("paymentPlan")} icon="calendar-clock" flush>
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
                        <td data-label={t("status")}>
                          {item.is_paid ? (
                            <Badge tone="good" icon="circle-check">
                              {t("planPaid")}
                            </Badge>
                          ) : (
                            <Badge icon="clock">{t("planOpen")}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionCard>
            )}

            {invoice.risk && open && (
              <SectionCard
                title={t("paymentRisk")}
                icon="gauge"
                iconTone={invoice.risk.level === "high" ? "warn" : "info"}
                actions={
                  <Badge tone={invoice.risk.level === "high" ? "warn" : invoice.risk.level === "medium" ? "neutral" : "good"} icon={invoice.risk.level === "high" ? "triangle-exclamation-point" : invoice.risk.level === "low" ? "circle-check" : "info"}>
                    {invoice.risk.level === "high" ? t("riskHigh") : invoice.risk.level === "medium" ? t("riskMedium") : t("riskLow")}
                  </Badge>
                }
              >
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
              </SectionCard>
            )}

            {open && (
              <SectionCard title={t("otherActions")} icon="banknote">
                {invoice.status !== "on_plan" && (
                  <form
                    className="inline-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const amount = bank.trim() ? toNumber(bank, lang) : invoice.open_cents / 100;
                      if (!(amount > 0)) {
                        setBankError(t("amountAboveZero"));
                        return;
                      }
                      const done = await act(() => post(`/api/invoices/${id}/record-payment`, { amount_eur: amount }), t("paymentRecorded"));
                      if (done) setBank("");
                    }}
                  >
                    <Field id="bank-payment" label={t("bankPayment")} help={t("bankPaymentHelp")} error={bankError} className="amount-field">
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
                    <Button type="submit" icon="landmark" busy={busy} pending={t("saving")}>
                      {t("recordPayment")}
                    </Button>
                  </form>
                )}
                {invoice.paid_cents === 0 && (
                  <div className="danger-zone">
                    <div>
                      <strong>{t("cancelInvoice")}</strong>
                      <p className="muted small">{t("cancelHint")}</p>
                    </div>
                    <ConfirmButton
                      icon="ban"
                      label={t("cancelInvoice")}
                      title={t("cancelTitle", { number: title })}
                      body={t("cancelHint")}
                      confirmLabel={t("cancelConfirm")}
                      disabled={busy}
                      onConfirm={() => act(() => post(`/api/invoices/${id}/cancel`, { reason: t("cancelReason") }), t("cancelled"))}
                    />
                  </div>
                )}
              </SectionCard>
            )}

            <SectionCard title={t("whatHappened")} icon="list-checks">
              {events === null ? null : events.length === 0 ? (
                <EmptyState icon="list-checks" title={t("nothingYet")} />
              ) : (
                <ol className="timeline">
                  {events.map((event) => (
                    <li key={event.id}>
                      <ActorBadge actor={event.actor} />
                      <div className="timeline-text">
                        <strong>{labels.audit[event.action] || event.action.replaceAll("_", " ")}</strong>
                        <span className="muted small">{eventText(event.data, tools)}</span>
                      </div>
                      <time className="timeline-when" dateTime={event.at}>
                        {dateTime(event.at)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </>
        }
      />
    </Page>
  );
}

function methodName(method: string, t: ReturnType<typeof useT>["t"]): string {
  const value = (method || "").toUpperCase();
  if (value === "BANK_TRANSFER") return t("methodBank");
  if (value === "PAYPAL" || value === "") return "PayPal";
  return value.replaceAll("_", " ").toLowerCase();
}
