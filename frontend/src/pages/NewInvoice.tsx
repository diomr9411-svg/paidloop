import { useEffect, useRef, useState } from "react";

import { addDays, api, customerLink, lineNetCents, numberText, post, put, toNumber, totals } from "../api";
import { Empty, ErrorBox, Field, useCopyLink } from "../components";
import { useT } from "../i18n";

type Line = { description: string; quantity: string; unit: string; price: string; vat: string };
type CustomerForm = { id: number | null; name: string; street: string; postcode: string; city: string; email: string; is_business: boolean; language: string };
type Step = "note" | "details" | "check" | "done";

const STORE = "paidloop.newInvoice";
const STEPS: Step[] = ["note", "details", "check", "done"];
const EMPTY_CUSTOMER: CustomerForm = { id: null, name: "", street: "", postcode: "", city: "", email: "", is_business: true, language: "de" };
const MAX_TIMED_SECONDS = 3600; // a longer time means the work was left open, so it isn't a fair measure

function loadSaved(): any {
  try {
    return JSON.parse(window.sessionStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
}

export function NewInvoice({ hash, refresh }: { hash: string; refresh: () => void }) {
  const { t, lang, labels, eur, day, duration } = useT();
  const copyLink = useCopyLink();
  const draftParam = Number(new URLSearchParams(hash.split("?")[1] || "").get("draft")) || null;
  const saved = useRef(draftParam ? null : loadSaved()).current;

  const [step, setStep] = useState<Step>(saved?.step === "details" ? "details" : saved?.step === "check" ? "details" : "note");
  const [note, setNote] = useState<string>(saved?.note || "");
  const [capture, setCapture] = useState<any>(saved?.capture || null);
  const [unsure, setUnsure] = useState<string[]>(saved?.unsure || []);
  const [customers, setCustomers] = useState<any[]>([]);
  const [customer, setCustomer] = useState<CustomerForm>(saved?.customer || EMPTY_CUSTOMER);
  const [customerOpen, setCustomerOpen] = useState<boolean>(saved ? !saved.customer?.id : true);
  const [lines, setLines] = useState<Line[]>(saved?.lines || []);
  const [dates, setDates] = useState<{ issue: string; service: string; due: string }>(saved?.dates || { issue: "", service: "", due: "" });
  const [propertyWork, setPropertyWork] = useState<boolean>(saved?.propertyWork || false);
  const [draftId, setDraftId] = useState<number | null>(saved?.draftId || draftParam);
  const [startedAt, setStartedAt] = useState<number | null>(saved?.startedAt || null);

  const [business, setBusiness] = useState<any>(null);
  const [todayIso, setTodayIso] = useState("");
  const [check, setCheck] = useState<any>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [issued, setIssued] = useState<any>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [restored, setRestored] = useState<boolean>(!!saved && saved.step !== "note");

  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null>(null);
  const skipStepFocus = useRef(true);

  const small = !!business?.small_business;
  const defaultVat = small ? "0" : "19";

  useEffect(() => {
    api<any[]>("/api/customers").then(setCustomers).catch(() => undefined);
    api("/api/business").then(setBusiness).catch(() => undefined);
    api("/api/demo/clock").then((clock) => setTodayIso(clock.today)).catch(() => undefined);
  }, []);

  // Open a saved draft from the list or from Next steps.
  useEffect(() => {
    if (!draftParam) return;
    api(`/api/invoices/${draftParam}`)
      .then((invoice) => {
        if (invoice.number) {
          window.location.hash = `#/invoices/${invoice.id}`;
          return;
        }
        setCustomer(invoice.customer ? { ...invoice.customer } : EMPTY_CUSTOMER);
        setCustomerOpen(!invoice.customer);
        setLines(
          invoice.lines.map((line: any) => ({
            description: line.description,
            quantity: numberText(line.quantity, lang),
            unit: line.unit,
            price: numberText(line.unit_price_cents / 100, lang),
            vat: String(line.vat_percent),
          })),
        );
        setDates({ issue: invoice.issue_date || "", service: invoice.service_date || "", due: invoice.due_date || "" });
        setPropertyWork(invoice.property_work);
        setNote(invoice.source_text || "");
        setStep("details");
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftParam]);

  // Keep unfinished work when the owner looks at another page.
  useEffect(() => {
    if (step === "done" || (!note && !lines.length)) return;
    window.sessionStorage.setItem(STORE, JSON.stringify({ step, note, capture, unsure, customer, lines, dates, propertyWork, draftId, startedAt }));
  }, [step, note, capture, unsure, customer, lines, dates, propertyWork, draftId, startedAt]);

  useEffect(() => {
    if (skipStepFocus.current) {
      skipStepFocus.current = false;
    } else if (!focusAfter.current) {
      heading.current?.focus();
      window.scrollTo(0, 0);
    }
    if (focusAfter.current) {
      const target = document.getElementById(focusAfter.current) as HTMLElement | null;
      focusAfter.current = null;
      target?.focus();
      target?.scrollIntoView({ block: "center" });
    }
  }, [step, customerOpen]);

  // Results from the server are in one language, so ask again after a switch.
  const lastLang = useRef(lang);
  useEffect(() => {
    if (lastLang.current === lang) return;
    lastLang.current = lang;
    if (step === "check" && draftId) post(`/api/invoices/${draftId}/check`).then(applyCheck).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const clock = () => todayIso || new Date().toISOString().slice(0, 10);

  function emptyLine(): Line {
    return { description: "", quantity: "1", unit: "H87", price: "", vat: defaultVat };
  }

  function fill(result: any) {
    const data = result.extracted;
    const vat = String(result.default_vat_percent);
    setCapture(result);
    setUnsure(result.unsure);
    setCheck(null);
    setFieldErrors({});
    setDraftId(null);
    setPropertyWork(result.property_work);
    setLines(
      data.lines.length
        ? data.lines.map((line: any) => ({
            description: line.description,
            quantity: numberText(line.quantity, lang),
            unit: line.unit === "hours" ? "HUR" : "H87",
            price: line.unit_price_eur == null ? "" : numberText(line.unit_price_eur, lang),
            vat,
          }))
        : [{ description: "", quantity: "1", unit: "H87", price: "", vat }],
    );
    setDates({ issue: result.today, service: data.service_date || "", due: addDays(result.today, result.payment_days) });
    if (result.known_customer) {
      setCustomer({ ...result.known_customer });
      setCustomerOpen(false);
      setUnsure((u) => u.filter((f: string) => f !== "customer_is_business" && f !== "customer_name"));
    } else {
      setCustomer({
        ...EMPTY_CUSTOMER,
        language: lang,
        name: data.customer_name,
        street: data.customer_street,
        postcode: data.customer_postcode,
        city: data.customer_city,
        email: data.customer_email,
        is_business: data.customer_is_business ?? true,
      });
      setCustomerOpen(true);
    }
    setStep("details");
  }

  function started() {
    setStartedAt((value) => value ?? Date.now());
  }

  async function read() {
    if (!note.trim()) {
      setError(t("writeFirst"));
      return;
    }
    started();
    setReading(true);
    setError("");
    try {
      fill(await post("/api/capture/text", { text: note }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function upload(file: File) {
    started();
    setReading(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await api("/api/capture/file", { method: "POST", body: form });
      setNote(result.source_text);
      fill(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function byHand() {
    started();
    setError("");
    setCapture(null);
    setUnsure([]);
    setCustomer({ ...EMPTY_CUSTOMER, language: lang });
    setCustomerOpen(true);
    setLines([emptyLine()]);
    const issue = clock();
    setDates({ issue, service: "", due: addDays(issue, business?.payment_days ?? 14) });
    setStep("details");
  }

  function startOver() {
    window.sessionStorage.removeItem(STORE);
    setStep("note");
    setNote("");
    setCapture(null);
    setUnsure([]);
    setCustomer(EMPTY_CUSTOMER);
    setCustomerOpen(true);
    setLines([]);
    setDates({ issue: "", service: "", due: "" });
    setPropertyWork(false);
    setDraftId(null);
    setCheck(null);
    setFieldErrors({});
    setIssued(null);
    setStartedAt(null);
    setElapsed(null);
    setError("");
    setRestored(false);
    if (window.location.hash !== "#/new") window.location.hash = "#/new";
  }

  function clearField(...ids: string[]) {
    setFieldErrors((all) => {
      const next = { ...all };
      ids.forEach((id) => delete next[id]);
      return next;
    });
  }

  function setLine(index: number, change: Partial<Line>) {
    setLines((all) => all.map((line, i) => (i === index ? { ...line, ...change } : line)));
    const key = Object.keys(change)[0];
    setUnsure((u) => u.filter((f) => f !== `lines.${index}.${key === "price" ? "unit_price" : key}`));
    clearField(`lines.${index + 1}.${key}`);
  }

  function removeLine(index: number) {
    setLines((all) => all.filter((_, i) => i !== index));
    setUnsure((all) =>
      all.flatMap((flag) => {
        const match = flag.match(/^lines\.(\d+)\.(.+)$/);
        if (!match) return [flag];
        const at = Number(match[1]);
        if (at === index) return [];
        return [at > index ? `lines.${at - 1}.${match[2]}` : flag];
      }),
    );
    setFieldErrors({});
  }

  function setCustomerField(change: Partial<CustomerForm>) {
    setCustomer((c) => ({ ...c, ...change }));
    if ("name" in change) setUnsure((u) => u.filter((f) => f !== "customer_name"));
    if ("is_business" in change) setUnsure((u) => u.filter((f) => f !== "customer_is_business"));
    const ids = Object.keys(change).map((key) => `buyer.${key}`);
    clearField(...ids);
  }

  function chooseByName(name: string) {
    const known = customers.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (known) {
      setCustomer({ ...known });
      setCustomerOpen(false);
      setUnsure((u) => u.filter((f) => f !== "customer_name" && f !== "customer_is_business"));
      clearField("buyer.name", "buyer.email", "buyer.street", "buyer.postcode", "buyer.city");
    } else {
      setCustomerField({ name, id: null });
    }
  }

  const computed = lines.map((line) => {
    const net = lineNetCents(toNumber(line.quantity, lang), toNumber(line.price, lang));
    return { net, vatPercent: small ? 0 : Number(line.vat) };
  });
  const sums = totals(computed);

  function applyCheck(result: any) {
    setCheck(result);
    const errors: Record<string, string> = {};
    for (const issue of result.issues) {
      if (issue.severity !== "error") continue;
      const id = targetOf(issue.field);
      if (id) errors[id] = issue.message;
    }
    setFieldErrors(errors);
  }

  async function saveAndCheck() {
    if (busy) return;
    if (!customer.name.trim()) {
      setError(t("enterCustomerName"));
      focusAfter.current = "buyer.name";
      setCustomerOpen(true);
      const target = document.getElementById("buyer.name");
      if (target) {
        focusAfter.current = null;
        target.focus();
      }
      return;
    }
    if (!lines.length) {
      setError(t("addOneItem"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const customerBody = {
        name: customer.name,
        street: customer.street,
        postcode: customer.postcode,
        city: customer.city,
        email: customer.email,
        is_business: customer.is_business,
        language: customer.language,
      };
      const savedCustomer = customer.id ? await put(`/api/customers/${customer.id}`, customerBody) : await post("/api/customers", customerBody);
      setCustomer((c) => ({ ...c, id: savedCustomer.id }));
      setCustomers((all) => (all.some((c) => c.id === savedCustomer.id) ? all.map((c) => (c.id === savedCustomer.id ? savedCustomer : c)) : [...all, savedCustomer]));
      const body = {
        customer_id: savedCustomer.id,
        lines: lines.map((line) => ({
          description: line.description,
          quantity: toNumber(line.quantity, lang),
          unit: line.unit,
          unit_price_eur: toNumber(line.price, lang),
          vat_percent: small ? 0 : toNumber(line.vat, lang),
        })),
        issue_date: dates.issue || null,
        service_date: dates.service || null,
        due_date: dates.due || null,
        property_work: propertyWork,
        source_text: capture?.source_text || note || "",
        capture_source: capture?.source || "manual",
      };
      const draft = draftId ? await put(`/api/invoices/${draftId}`, body) : await post("/api/invoices", body);
      setDraftId(draft.id);
      applyCheck(await post(`/api/invoices/${draft.id}/check`));
      setStep("check");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    if (busy || !draftId) return;
    setBusy(true);
    setError("");
    const seconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
    const timed = seconds !== null && seconds <= MAX_TIMED_SECONDS ? seconds : null;
    try {
      const result = await post(`/api/invoices/${draftId}/issue`, { seconds_to_issue: timed });
      window.sessionStorage.removeItem(STORE);
      setIssued(result);
      setElapsed(timed);
      setStep("done");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function goToField(field: string) {
    const id = targetOf(field);
    if (id?.startsWith("buyer.")) setCustomerOpen(true);
    focusAfter.current = id;
    setStep("details");
  }

  const flag = (field: string) => unsure.includes(field);
  const firstFixable = check?.issues.find((item: any) => item.severity === "error" && targetOf(item.field));
  const stepIndex = STEPS.indexOf(step);

  return (
    <>
      <div className="title-row">
        <h1>{t("newInvoice")}</h1>
        {step !== "note" && step !== "done" && (
          <button className="link" onClick={startOver}>
            {t("startOver")}
          </button>
        )}
      </div>

      <ol className="stepper" aria-label={t("stepsLabel")}>
        {STEPS.map((name, index) => {
          const label = { note: t("stepNote"), details: t("stepDetails"), check: t("stepCheck"), done: t("stepDone") }[name];
          return (
            <li key={name} className={index === stepIndex ? "current" : index < stepIndex ? "complete" : ""} aria-current={index === stepIndex ? "step" : undefined}>
              <span className="step-mark" aria-hidden="true">
                {index < stepIndex ? "✓" : index + 1}
              </span>
              {label}
            </li>
          );
        })}
      </ol>

      {restored && step !== "done" && (
        <div className="alert info" role="status">
          {t("draftRestored")}
        </div>
      )}
      {error && <ErrorBox text={error} />}

      {step === "note" && (
        <section
          className={`card dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) upload(file);
          }}
        >
          <h2 ref={heading} tabIndex={-1}>
            {t("noteTitle")}
          </h2>
          <p className="muted">{dragging ? t("dropHere") : t("noteHint")}</p>
          <label className="sr-only" htmlFor="job-note">
            {t("noteLabel")}
          </label>
          <textarea
            id="job-note"
            rows={4}
            value={note}
            maxLength={4000}
            autoFocus
            placeholder={t("noteExample")}
            onChange={(event) => {
              if (event.target.value) started();
              setNote(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                read();
              }
            }}
          />
          <div className="button-row">
            <button className="primary big" disabled={reading} aria-busy={reading} onClick={read}>
              {reading ? t("reading") : t("readNote")}
            </button>
            <button disabled={reading} onClick={() => fileInput.current?.click()}>
              {t("uploadFile")}
            </button>
            <button disabled={reading} onClick={byHand}>
              {t("byHand")}
            </button>
            <button className="link" disabled={reading} onClick={() => setNote(t("noteExample"))}>
              {t("useExample")}
            </button>
            <kbd className="hint-key">Ctrl + Enter</kbd>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])}
            />
          </div>
          {reading && (
            <p className="muted small" role="status">
              {t("readingHint")}
            </p>
          )}
        </section>
      )}

      {step === "details" && (
        <div
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              saveAndCheck();
            }
          }}
        >
          <section className="card">
            <div className="title-row">
              <h2 ref={heading} tabIndex={-1}>
                {t("detailsTitle")}
              </h2>
              <span className="chip">{capture?.source === "ai" ? t("readByAi") : capture ? t("readByRules") : t("enteredByHand")}</span>
            </div>
            {capture?.warnings?.map((warning: any) => (
              <div className="alert warn" key={warning.en}>
                ! {warning[lang]}
              </div>
            ))}
            {unsure.length > 0 && <p className="note-unsure">! {t("unsureNote")}</p>}

            <h3>{t("customerSection")}</h3>
            {customer.id && !customerOpen ? (
              <div className="known">
                <div>
                  <span className="muted small">{t("knownCustomer")}</span>
                  <div>
                    <strong>{customer.name}</strong>
                  </div>
                  <div className="small muted">
                    {[customer.street, [customer.postcode, customer.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                  </div>
                  <div className="small muted">
                    {customer.email || t("noEmailYet")} · {customer.is_business ? t("typeBusiness") : t("typePrivate")} ·{" "}
                    {customer.language === "en" ? t("langEnglish") : t("langGerman")}
                  </div>
                </div>
                <div className="button-row tight">
                  <button onClick={() => setCustomerOpen(true)}>{t("editDetails")}</button>
                  <button
                    onClick={() => {
                      setCustomer({ ...EMPTY_CUSTOMER, language: lang });
                      setCustomerOpen(true);
                      focusAfter.current = "buyer.name";
                    }}
                  >
                    {t("chooseAnother")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="form-grid">
                <Field
                  id="buyer.name"
                  label={t("customerName")}
                  hint={customer.id ? undefined : t("customerNameHint")}
                  unsure={flag("customer_name")}
                  error={fieldErrors["buyer.name"]}
                >
                  <input
                    list="known-customers"
                    autoComplete="off"
                    value={customer.name}
                    onChange={(event) => (customer.id ? setCustomerField({ name: event.target.value }) : chooseByName(event.target.value))}
                  />
                </Field>
                <datalist id="known-customers">
                  {customers.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
                <Field id="buyer.email" label={t("email")} error={fieldErrors["buyer.email"]}>
                  <input type="email" value={customer.email} onChange={(event) => setCustomerField({ email: event.target.value })} />
                </Field>
                <Field id="buyer.street" label={t("street")} error={fieldErrors["buyer.street"]}>
                  <input
                    value={customer.street}
                    onChange={(event) => setCustomerField({ street: event.target.value })}
                  />
                </Field>
                <div className="form-pair">
                  <Field id="buyer.postcode" label={t("postcode")}>
                    <input value={customer.postcode} onChange={(event) => setCustomerField({ postcode: event.target.value })} />
                  </Field>
                  <Field id="buyer.city" label={t("city")}>
                    <input value={customer.city} onChange={(event) => setCustomerField({ city: event.target.value })} />
                  </Field>
                </div>
                <Field id="buyer.type" label={t("customerType")} unsure={flag("customer_is_business")}>
                  <select value={customer.is_business ? "b" : "p"} onChange={(event) => setCustomerField({ is_business: event.target.value === "b" })}>
                    <option value="b">{t("typeBusiness")}</option>
                    <option value="p">{t("typePrivate")}</option>
                  </select>
                </Field>
                <Field id="buyer.language" label={t("customerLanguage")} hint={t("customerLanguageHint")}>
                  <select value={customer.language} onChange={(event) => setCustomerField({ language: event.target.value })}>
                    <option value="de">{t("langGerman")}</option>
                    <option value="en">{t("langEnglish")}</option>
                  </select>
                </Field>
              </div>
            )}

            <h3>{t("workSection")}</h3>
            <div className="lines">
              {lines.map((line, index) => {
                const position = index + 1;
                return (
                  <div className="line" key={index}>
                    <Field
                      id={`lines.${position}.description`}
                      label={t("what")}
                      unsure={flag(`lines.${index}.description`)}
                      error={fieldErrors[`lines.${position}.description`]}
                    >
                      <input value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} />
                    </Field>
                    <Field
                      id={`lines.${position}.quantity`}
                      label={t("qty")}
                      unsure={flag(`lines.${index}.quantity`)}
                      error={fieldErrors[`lines.${position}.quantity`]}
                    >
                      <input inputMode="decimal" value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })} />
                    </Field>
                    <Field id={`lines.${position}.unit`} label={t("unit")}>
                      <select value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })}>
                        <option value="HUR">{t("unitHours")}</option>
                        <option value="H87">{t("unitPieces")}</option>
                      </select>
                    </Field>
                    <Field
                      id={`lines.${position}.price`}
                      label={t("netPrice")}
                      unsure={flag(`lines.${index}.unit_price`)}
                      error={fieldErrors[`lines.${position}.price`]}
                    >
                      <input inputMode="decimal" value={line.price} onChange={(event) => setLine(index, { price: event.target.value })} />
                    </Field>
                    <Field id={`lines.${position}.vat`} label={t("vatPercent")} error={fieldErrors[`lines.${position}.vat`]}>
                      {small ? (
                        <select disabled value="0" title={t("smallBusinessNoVat")}>
                          <option value="0">0</option>
                        </select>
                      ) : (
                        <select value={line.vat} onChange={(event) => setLine(index, { vat: event.target.value })}>
                          <option value="19">19</option>
                          <option value="7">7</option>
                        </select>
                      )}
                    </Field>
                    <div className="line-total">
                      <span className="line-total-label">{t("lineTotal")}</span>
                      {eur(computed[index]?.net || 0)}
                    </div>
                    <button className="link line-remove" aria-label={t("removeItemLabel", { n: position })} onClick={() => removeLine(index)}>
                      {t("removeItem")}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="button-row">
              <button
                id="add-item"
                onClick={() => {
                  setLines((all) => [...all, emptyLine()]);
                  focusAfter.current = null;
                  window.setTimeout(() => document.getElementById(`lines.${lines.length + 1}.description`)?.focus(), 0);
                }}
              >
                {t("addItem")}
              </button>
              {small && <span className="muted small">{t("smallBusinessNoVat")}</span>}
            </div>

            <h3>{t("datesSection")}</h3>
            <div className="form-grid three">
              <Field id="issue_date" label={t("invoiceDate")} error={fieldErrors["issue_date"]}>
                <input type="date" value={dates.issue} onChange={(event) => (setDates({ ...dates, issue: event.target.value }), clearField("issue_date"))} />
              </Field>
              <div>
                <Field id="service_date" label={t("workDate")} unsure={flag("service_date")} error={fieldErrors["service_date"]}>
                  <input
                    type="date"
                    value={dates.service}
                    onChange={(event) => {
                      setDates({ ...dates, service: event.target.value });
                      setUnsure((u) => u.filter((f) => f !== "service_date"));
                      clearField("service_date");
                    }}
                  />
                </Field>
                <div className="date-chips">
                  {[
                    [t("today"), 0],
                    [t("yesterday"), -1],
                  ].map(([label, shift]) => (
                    <button
                      key={label}
                      className="small"
                      type="button"
                      onClick={() => {
                        setDates({ ...dates, service: addDays(clock(), shift as number) });
                        setUnsure((u) => u.filter((f) => f !== "service_date"));
                        clearField("service_date");
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Field id="due_date" label={t("paymentDue")} error={fieldErrors["due_date"]}>
                  <input type="date" value={dates.due} onChange={(event) => (setDates({ ...dates, due: event.target.value }), clearField("due_date"))} />
                </Field>
                <div className="date-chips">
                  {[7, 14, 30].map((days) => (
                    <button
                      key={days}
                      className="small"
                      type="button"
                      onClick={() => {
                        setDates({ ...dates, due: addDays(dates.issue || clock(), days) });
                        clearField("due_date");
                      }}
                    >
                      {t("inDays", { n: days })}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={propertyWork} onChange={(event) => setPropertyWork(event.target.checked)} />
              {t("propertyWork")}
            </label>
          </section>

          <div className="action-bar">
            <button onClick={() => setStep("note")}>{t("back")}</button>
            <div className="sums" aria-live="polite">
              <span>
                {t("net")} <strong>{eur(sums.net)}</strong>
              </span>
              <span>
                {t("vat")} <strong>{eur(sums.vat)}</strong>
              </span>
              <span className="sum-total">
                {t("total")} <strong>{eur(sums.gross)}</strong>
              </span>
            </div>
            <button className="primary big" disabled={busy || lines.length === 0} aria-busy={busy} onClick={saveAndCheck}>
              {busy ? t("checking") : t("checkInvoice")}
            </button>
          </div>
        </div>
      )}

      {step === "check" && check && (
        <>
          <section className="card">
            <h2 ref={heading} tabIndex={-1}>
              {t("checkTitle")}
            </h2>
            {check.issues.length === 0 && <p>{t("noProblems")}</p>}
            <ul className="issues">
              {check.issues.map((issue: any) => {
                const seller = issue.field.startsWith("seller");
                const target = targetOf(issue.field);
                return (
                  <li key={`${issue.rule_id}-${issue.field}`} className={issue.severity}>
                    <span className="issue-tag">{issue.severity === "error" ? `! ${t("mustFix")}` : issue.severity === "warning" ? `! ${t("lookAt")}` : `i ${t("noteTag")}`}</span>
                    <div>
                      <strong>{issue.message}</strong>
                      <div className="small">{issue.fix}</div>
                      <div className="muted small">{issue.law}</div>
                    </div>
                    {issue.severity === "error" &&
                      (seller ? (
                        <a className="button" href="#/settings">
                          {t("openSettings")}
                        </a>
                      ) : target ? (
                        <button onClick={() => goToField(issue.field)}>{t("goToField")}</button>
                      ) : null)}
                  </li>
                );
              })}
            </ul>
            {check.notes_to_print.length > 0 && (
              <div className="printed-notes">
                <strong>{t("printedNotes")}</strong>
                <ul className="plain">
                  {check.notes_to_print.map((text: string) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {check.can_issue && (
            <section className="card summary-card">
              <h2>{t("summary")}</h2>
              <dl className="facts">
                <dt>{t("customer")}</dt>
                <dd>{customer.name}</dd>
                <dt>{t("sentTo")}</dt>
                <dd>{customer.email}</dd>
                <dt>{t("invoiceLanguage")}</dt>
                <dd>{customer.language === "en" ? t("langEnglish") : t("langGerman")}</dd>
                <dt>{t("paymentDue")}</dt>
                <dd>{day(dates.due)}</dd>
                <dt>{t("net")}</dt>
                <dd className="tabular">{eur(sums.net)}</dd>
                <dt>{t("vat")}</dt>
                <dd className="tabular">{eur(sums.vat)}</dd>
                <dt>
                  <strong>{t("total")}</strong>
                </dt>
                <dd className="tabular">
                  <strong>{eur(sums.gross)}</strong>
                </dd>
              </dl>
              <p className="muted small issue-hint">{t("issueHint")}</p>
            </section>
          )}

          <div className="action-bar">
            <button onClick={() => setStep("details")}>{t("back")}</button>
            {check.can_issue ? (
              <button className="primary big" disabled={busy} aria-busy={busy} onClick={issue}>
                {busy ? t("issuing") : t("issueInvoice")}
              </button>
            ) : (
              <>
                <span className="note-unsure">! {t("fixFirst")}</span>
                {firstFixable ? (
                  <button className="primary big" onClick={() => goToField(firstFixable.field)}>
                    {t("goToField")}
                  </button>
                ) : (
                  <button className="primary big" disabled={busy} aria-busy={busy} onClick={saveAndCheck}>
                    {busy ? t("checking") : t("checkAgain")}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {step === "done" && issued && (
        <section className="card done-card">
          <Empty
            title={`✓ ${t("doneTitle", { number: issued.number })}`}
            hint={
              <>
                {t("doneNext")} {elapsed !== null && t("doneTime", { time: duration(elapsed) })}
              </>
            }
          />
          <div className="button-row center-row">
            <a className="button primary" href={`/api/invoices/${issued.id}/pdf`}>
              {t("downloadPdf")}
            </a>
            <button onClick={() => copyLink(customerLink(issued.public_token))}>{t("copyLink")}</button>
            <a className="button" href={`#/invoices/${issued.id}`}>
              {t("openInvoice")}
            </a>
            <button onClick={startOver}>{t("anotherInvoice")}</button>
          </div>
          <span className="sr-only">{labels.status[issued.status]}</span>
        </section>
      )}
    </>
  );
}

/** Where to go to fix a problem from the check. */
function targetOf(field: string): string | null {
  if (field === "buyer.address") return "buyer.street";
  if (field === "lines") return "add-item";
  if (/^lines\.\d+\.net$/.test(field)) return field.replace(".net", ".price");
  if (field === "vat" || field === "gross" || field === "notes" || field === "format" || field.startsWith("seller")) return null;
  return field;
}
