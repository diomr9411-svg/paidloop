import { useEffect, useRef, useState } from "react";

import { ApiError, api, day, eurFor, post } from "../api";

const TEXT = {
  de: {
    invoiceFrom: "Rechnung von",
    open: "Offener Betrag",
    due: "Fällig am",
    pay: "Jetzt mit PayPal bezahlen",
    paySim: "Jetzt bezahlen (Simulation)",
    download: "Rechnung herunterladen (PDF)",
    paid: "Vielen Dank! Diese Rechnung ist bezahlt.",
    cancelled: "Diese Rechnung wurde storniert.",
    plan: "Ihr Zahlungsplan",
    payment: "Rate",
    payThis: "Diese Rate bezahlen",
    done: "Bezahlt",
    offer: "Unser Angebot",
    accept: "Plan annehmen",
    help: "Können wir helfen?",
    welcome: "Guten Tag! Wenn Sie gerade nicht alles bezahlen können oder etwas an der Rechnung nicht stimmt, schreiben Sie es mir einfach.",
    placeholder: "Schreiben Sie hier...",
    send: "Senden",
    thinking: "Einen Moment bitte...",
    hold: "Die Erinnerungen sind angehalten, bis Ihr Anliegen geprüft wurde.",
    invalid: "Dieser Link ist nicht gültig.",
    note: "Testumgebung. Es wird kein echtes Geld bewegt.",
  },
  en: {
    invoiceFrom: "Invoice from",
    open: "Amount open",
    due: "Due on",
    pay: "Pay now with PayPal",
    paySim: "Pay now (simulation)",
    download: "Download invoice (PDF)",
    paid: "Thank you! This invoice is paid.",
    cancelled: "This invoice was cancelled.",
    plan: "Your payment plan",
    payment: "Payment",
    payThis: "Pay this one",
    done: "Paid",
    offer: "Our offer",
    accept: "Accept plan",
    help: "Can we help?",
    welcome: "Hello! If you can't pay it all right now, or something about the invoice is wrong, just tell me.",
    placeholder: "Write here...",
    send: "Send",
    thinking: "One moment please...",
    hold: "Reminders are paused until the owner has looked at your message.",
    invalid: "This link is not valid.",
    note: "Test environment. No real money moves.",
  },
};

export function PayPage({ token }: { token: string }) {
  const [page, setPage] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  const [chosenLanguage, setChosenLanguage] = useState<"de" | "en" | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/api/pay/${token}`)
        .then((data) => alive && setPage(data))
        .catch((e) => {
          if (alive && e instanceof ApiError && e.status === 404) setNotFound(true);
        });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [page?.messages?.length, pending]);

  if (notFound) return <div className="paypage"><div className="card">{TEXT.en.invalid}</div></div>;
  if (!page) return <div className="paypage"><p className="muted">...</p></div>;

  const language: "de" | "en" = chosenLanguage || (page.language === "en" ? "en" : "de");
  const t = TEXT[language];
  const money = (cents: number) => eurFor(cents, language);
  const closed = page.status === "paid" || page.status === "cancelled";

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    setPending(text);
    setDraft("");
    try {
      const answer = await post(`/api/pay/${token}/chat`, { text });
      setPage(answer.page);
      setChosenLanguage(null); // follow the language the customer just wrote in
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
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
    <div className="paypage">
      <section className="card pay-head">
        <div className="pay-top">
          <div className="muted">
            {t.invoiceFrom} {page.seller}
          </div>
          <div className="lang-switch" role="group" aria-label="Language">
            {(["de", "en"] as const).map((code) => (
              <button key={code} className={`small ${language === code ? "selected" : ""}`} onClick={() => setChosenLanguage(code)}>
                {code.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <h1>{page.number}</h1>

        {page.status === "paid" && <div className="alert good">✓ {t.paid}</div>}
        {page.status === "cancelled" && <div className="alert">{t.cancelled}</div>}
        {page.status === "disputed" && <div className="alert warn">! {t.hold}</div>}

        {!closed && (
          <>
            <div className="tile-label">{t.open}</div>
            <div className="hero-value">{money(page.open_cents)}</div>
            <div className="muted">
              {t.due}: {day(page.due_date)}
            </div>
            {page.pay_link && !page.simulated && (
              <a className="button primary big block" href={page.pay_link} target="_blank" rel="noreferrer">
                {t.pay}
              </a>
            )}
            {page.simulated && !page.plan && (
              <button className="primary big block" disabled={sending} onClick={simulatePay}>
                {t.paySim}
              </button>
            )}
          </>
        )}
        <a className="button block" href={`/api/pay/${token}/pdf`}>
          {t.download}
        </a>
      </section>

      {page.plan && (
        <section className="card">
          <h2>{t.plan}</h2>
          <ul className="plan">
            {page.plan.installments.map((item: any, index: number) => {
              const isNext = !item.is_paid && page.plan.installments.findIndex((i: any) => !i.is_paid) === index;
              return (
                <li key={item.seq} className={item.is_paid ? "is-paid" : ""}>
                  <span>
                    {t.payment} {item.seq}: <strong>{money(item.amount_cents)}</strong> ({day(item.due_date)})
                  </span>
                  {item.is_paid ? (
                    <span className="pill good">✓ {t.done}</span>
                  ) : isNext && page.simulated ? (
                    <button className="primary" disabled={sending} onClick={simulatePay}>
                      {t.paySim}
                    </button>
                  ) : item.pay_link && !page.simulated ? (
                    <a className={`button ${isNext ? "primary" : ""}`} href={item.pay_link} target="_blank" rel="noreferrer">
                      {t.payThis}
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
          <h2>{t.offer}</h2>
          <ul className="plan">
            {page.offer.installments.map((item: any) => (
              <li key={item.seq}>
                <span>
                  {t.payment} {item.seq}: <strong>{money(item.amount_cents)}</strong> ({day(item.due_date)})
                </span>
              </li>
            ))}
          </ul>
          <button className="primary big block" disabled={sending} onClick={() => accept(page.offer.id)}>
            {t.accept}
          </button>
        </section>
      )}

      {!closed && (
        <section className="card">
          <h2>{t.help}</h2>
          <div className="chat">
            <div className="bubble agent">{t.welcome}</div>
            {page.messages.map((message: any, index: number) => (
              <div key={index} className={`bubble ${message.role}`}>
                {message.text}
              </div>
            ))}
            {pending && <div className="bubble customer">{pending}</div>}
            {pending && <div className="bubble agent thinking">{t.thinking}</div>}
            <div ref={chatEnd} />
          </div>
          {error && <div className="alert error">{error}</div>}
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input value={draft} maxLength={1000} placeholder={t.placeholder} aria-label={t.placeholder} onChange={(e) => setDraft(e.target.value)} />
            <button className="primary" disabled={sending || !draft.trim()}>
              {t.send}
            </button>
          </form>
        </section>
      )}
      <p className="muted small center">{t.note}</p>
    </div>
  );
}
