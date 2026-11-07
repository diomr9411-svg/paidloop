import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api, post, setApiLanguage } from "../api";
import { ErrorBox, LangSwitch } from "../components";
import { Key, Lang, toolsFor, useT } from "../i18n";

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
      <div className="paypage">
        <div className="card">{t("linkInvalid")}</div>
      </div>
    );
  if (!page)
    return (
      <div className="paypage">
        <p className="muted" role="status">
          {t("loading")}
        </p>
      </div>
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
    <div className="paypage" lang={language}>
      <section className="card pay-head">
        <div className="pay-top">
          <div className="muted">
            {t("invoiceFrom")} {page.seller}
          </div>
          <LangSwitch value={language} onChange={setChosen} />
        </div>
        <h1>{page.number}</h1>

        {page.status === "paid" && (
          <div className="alert good" role="status">
            ✓ {t("payPaid")}
          </div>
        )}
        {page.status === "cancelled" && (
          <div className="alert" role="status">
            {t("payCancelled")}
          </div>
        )}
        {page.status === "disputed" && (
          <div className="alert warn" role="status">
            ! {t("payHold")}
          </div>
        )}

        {!closed && (
          <>
            <div className="tile-label">{t("amountOpen")}</div>
            <div className="hero-value">{money(page.open_cents)}</div>
            <div className="muted">
              {t("dueOn")}: {day(page.due_date)}
            </div>
            {page.pay_link && !page.simulated && (
              <a className="button primary big block" href={page.pay_link} target="_blank" rel="noreferrer">
                {t("payNow")}
              </a>
            )}
            {page.simulated && !page.plan && (
              <button className="primary big block" disabled={sending} onClick={simulatePay}>
                {t("payNowSim")}
              </button>
            )}
          </>
        )}
        <a className="button block" href={`/api/pay/${token}/pdf`}>
          {t("downloadInvoice")}
        </a>
      </section>

      {page.plan && (
        <section className="card">
          <h2>{t("yourPlan")}</h2>
          <ul className="plan">
            {page.plan.installments.map((item: any, index: number) => {
              const isNext = !item.is_paid && page.plan.installments.findIndex((i: any) => !i.is_paid) === index;
              return (
                <li key={item.seq} className={item.is_paid ? "is-paid" : ""}>
                  <span>
                    {t("planPayment")} {item.seq}: <strong>{money(item.amount_cents)}</strong> ({day(item.due_date)})
                  </span>
                  {item.is_paid ? (
                    <span className="pill good">✓ {t("payDone")}</span>
                  ) : isNext && page.simulated ? (
                    <button className="primary" disabled={sending} onClick={simulatePay}>
                      {t("payNowSim")}
                    </button>
                  ) : item.pay_link && !page.simulated ? (
                    <a className={`button ${isNext ? "primary" : ""}`} href={item.pay_link} target="_blank" rel="noreferrer">
                      {t("payThis")}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {page.offer && !closed && (
        <section className="card offer">
          <h2>{t("ourOffer")}</h2>
          <ul className="plan">
            {page.offer.installments.map((item: any) => (
              <li key={item.seq}>
                <span>
                  {t("planPayment")} {item.seq}: <strong>{money(item.amount_cents)}</strong> ({day(item.due_date)})
                </span>
              </li>
            ))}
          </ul>
          <button className="primary big block" disabled={sending} onClick={() => accept(page.offer.id)}>
            {t("acceptPlan")}
          </button>
        </section>
      )}

      {!closed && (
        <section className="card">
          <h2>{t("canWeHelp")}</h2>
          <div className="chat" role="log" aria-live="polite" aria-label={t("chatLog")}>
            <div className="bubble agent">{t("chatWelcome")}</div>
            {page.messages.map((message: any, index: number) => (
              <div key={index} className={`bubble ${message.role}`}>
                {message.text}
              </div>
            ))}
            {pending && <div className="bubble customer">{pending}</div>}
            {pending && <div className="bubble agent thinking">{t("oneMoment")}</div>}
            <div ref={chatEnd} />
          </div>
          {page.messages.length === 0 && (
            <div className="suggestions">
              {CHIPS.map((key) => (
                <button key={key} className="suggestion" disabled={sending} onClick={() => send(t(key))}>
                  {t(key)}
                </button>
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
            <button className="primary" disabled={sending || !draft.trim()}>
              {t("send")}
            </button>
          </form>
        </section>
      )}
      <p className="muted small center">{t("testEnvironment")}</p>
    </div>
  );
}
