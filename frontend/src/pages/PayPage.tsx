import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api, post, setApiLanguage } from "../api";
import { Key, Lang, toolsFor, useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { Card, SectionCard } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Icon, IconTile, InitialsTile } from "../ui/Icon";
import { Split } from "../ui/Layout";
import { Loading } from "../ui/Loading";
import { Page } from "../ui/PageHeader";
import { LangSwitch } from "../widgets/LangSwitch";

const CHIPS: Key[] = ["chipMoreTime", "chipWrong", "chipPaid", "chipOwner"];

/** The customer's page. Big targets for phones, and it follows the customer's language, not the owner's. */
export function PayPage({ token }: { token: string }) {
  const { lang: ownerLang } = useT();
  const [page, setPage] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const [chosen, setChosen] = useState<Lang | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const language: Lang = chosen || (page ? (page.language === "en" ? "en" : "de") : ownerLang);
  const tools = useMemo(() => toolsFor(language), [language]);
  const { t, eur: money, day } = tools;
  setApiLanguage(language);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t("invoiceFrom") + (page ? ` ${page.seller}` : "");
  }, [language, page, t]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/api/pay/${token}`)
        .then((data) => alive && setPage(data))
        .catch((e) => {
          if (alive && e instanceof ApiError && e.status === 404) setNotFound(true);
        });
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [page?.messages?.length, pending]);

  if (notFound)
    return (
      <main className="paypage">
        <Card>
          <EmptyState icon="link" tone="warn" heading title={t("linkInvalid")} hint={t("linkInvalidHint")} />
        </Card>
      </main>
    );
  if (!page)
    return (
      <main className="paypage">
        <Loading shape="cards" />
      </main>
    );

  const closed = page.status === "paid" || page.status === "cancelled";

  async function send(value?: string) {
    const text = (value ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    setPending(text);
    setDraft("");
    try {
      const answer = await post(`/api/pay/${token}/chat`, { text });
      setPage(answer.page);
      setChosen(null); // follow the language the customer just wrote in
    } catch (e) {
      setError((e as Error).message);
      if (!value) setDraft(text);
    } finally {
      setSending(false);
      setPending("");
    }
  }

  async function accept(planId: number) {
    setSending(true);
    setError("");
    try {
      const answer = await post(`/api/pay/${token}/offers/${planId}/accept`);
      setPage(answer.page);
    } catch (e) {
      setError((e as Error).message);
      api(`/api/pay/${token}`).then(setPage).catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  async function simulatePay() {
    setSending(true);
    try {
      setPage(await post(`/api/pay/${token}/simulate-payment`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="paypage" lang={language}>
      <Page template="customer">
        <div className="pay-top">
          <div className="pay-seller">
            <InitialsTile name={page.seller} />
            <div>
              <span className="eyebrow">{t("invoiceFrom")}</span>
              <strong>{page.seller}</strong>
            </div>
          </div>
          <LangSwitch value={language} onChange={setChosen} />
        </div>

        <Split
          even
          main={
            <>
              <section className="card pay-head" aria-labelledby="pay-title">
                <div className="pay-title-row">
                  <h1 id="pay-title">{page.number}</h1>
                  {page.status === "paid" && (
                    <Badge tone="good" icon="circle-check">
                      {t("payDone")}
                    </Badge>
                  )}
                </div>

                {page.status === "paid" && (
                  <Alert tone="good" role="status">
                    {t("payPaid")}
                  </Alert>
                )}
                {page.status === "cancelled" && (
                  <Alert icon="ban" role="status">
                    {t("payCancelled")}
                  </Alert>
                )}
                {page.status === "disputed" && (
                  <Alert tone="warn" icon="circle-pause" role="status">
                    {t("payHold")}
                  </Alert>
                )}

                {!closed && (
                  <div className="pay-amount">
                    <span className="stat-label">{t("amountOpen")}</span>
                    <p className="hero-value">{money(page.open_cents)}</p>
                    <span className="pay-due">
                      <Icon name="calendar" size="sm" />
                      {t("dueOn")}: {day(page.due_date)}
                    </span>
                  </div>
                )}
                {!closed && page.pay_link && !page.simulated && (
                  <ButtonLink tone="primary" size="lg" icon="credit-card" full href={page.pay_link} external>
                    {t("payNow")}
                  </ButtonLink>
                )}
                {!closed && page.simulated && !page.plan && (
                  <Button tone="primary" size="lg" icon="credit-card" full busy={sending} pending={t("working")} onClick={simulatePay}>
                    {t("payNowSim")}
                  </Button>
                )}
                <ButtonLink size="lg" icon="download" full href={`/api/pay/${token}/pdf`}>
                  {t("downloadInvoice")}
                </ButtonLink>
              </section>

              {page.plan && (
                <SectionCard title={t("yourPlan")} icon="calendar-clock">
                  <ul className="rows">
                    {page.plan.installments.map((item: any, index: number) => {
                      const isNext = !item.is_paid && page.plan.installments.findIndex((i: any) => !i.is_paid) === index;
                      return (
                        <li key={item.seq} className="row-item plan-row">
                          <span className="plan-seq">{item.seq}</span>
                          <div className="row-text">
                            <strong className="row-title">{money(item.amount_cents)}</strong>
                            <span className="row-meta">
                              {t("planPayment")} {item.seq} · {day(item.due_date)}
                            </span>
                          </div>
                          {item.is_paid ? (
                            <Badge tone="good" icon="circle-check">
                              {t("payDone")}
                            </Badge>
                          ) : isNext && page.simulated ? (
                            <Button tone="primary" size="sm" busy={sending} pending={t("working")} onClick={simulatePay}>
                              {t("payNowSim")}
                            </Button>
                          ) : item.pay_link && !page.simulated ? (
                            <ButtonLink tone={isNext ? "primary" : "secondary"} size="sm" href={item.pay_link} external>
                              {t("payThis")}
                            </ButtonLink>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </SectionCard>
              )}

              {page.offer && !closed && (
                <SectionCard title={t("ourOffer")} icon="calendar-clock" tone="brand">
                  <ul className="rows">
                    {page.offer.installments.map((item: any) => (
                      <li key={item.seq} className="row-item plan-row">
                        <span className="plan-seq">{item.seq}</span>
                        <div className="row-text">
                          <strong className="row-title">{money(item.amount_cents)}</strong>
                          <span className="row-meta">
                            {t("planPayment")} {item.seq} · {day(item.due_date)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Button tone="primary" size="lg" icon="check" full busy={sending} pending={t("working")} onClick={() => accept(page.offer.id)}>
                    {t("acceptPlan")}
                  </Button>
                </SectionCard>
              )}

            </>
          }
          side={
            !closed && (
              <SectionCard title={t("canWeHelp")} icon="message-square">
                <div className="chat" role="log" aria-live="polite" aria-label={t("chatLog")}>
                  <div className="bubble-row agent">
                    <IconTile name="sparkles" size="sm" />
                    <div className="bubble agent">{t("chatWelcome")}</div>
                  </div>
                  {page.messages.map((message: any, index: number) => (
                    <div key={index} className={`bubble-row ${message.role}`}>
                      {message.role !== "customer" && <IconTile name="sparkles" size="sm" />}
                      <div className={`bubble ${message.role}`}>{message.text}</div>
                    </div>
                  ))}
                  {pending && (
                    <div className="bubble-row customer">
                      <div className="bubble customer">{pending}</div>
                    </div>
                  )}
                  {pending && (
                    <div className="bubble-row agent">
                      <IconTile name="sparkles" size="sm" />
                      <div className="bubble agent thinking">{t("oneMoment")}</div>
                    </div>
                  )}
                  <div ref={chatEnd} />
                </div>
                {page.messages.length === 0 && (
                  <div className="suggestions">
                    {CHIPS.map((key) => (
                      <Button key={key} size="sm" className="suggestion" disabled={sending} onClick={() => send(t(key))}>
                        {t(key)}
                      </Button>
                    ))}
                  </div>
                )}
                {error && <ErrorBox text={error} />}
                <form
                  className="chat-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send();
                  }}
                >
                  <input value={draft} maxLength={1000} placeholder={t("chatPlaceholder")} aria-label={t("chatPlaceholder")} onChange={(event) => setDraft(event.target.value)} />
                  <Button type="submit" tone="primary" icon="send" disabled={sending || !draft.trim()}>
                    {t("send")}
                  </Button>
                </form>
              </SectionCard>
            )
          }
        />
        <p className="pay-foot">
          <Icon name="info" size="sm" />
          {t("testEnvironment")}
        </p>
      </Page>
    </main>
  );
}
