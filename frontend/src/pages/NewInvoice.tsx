import { ReactNode, useEffect, useRef, useState } from "react";

import { addDays, api, customerLink, lineNetCents, numberText, post, put, toNumber, totals } from "../api";
import { useT } from "../i18n";
import { Alert, ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { cx } from "../ui/cx";
import { EmptyState } from "../ui/EmptyState";
import { Field, FieldGrid, Switch } from "../ui/Field";
import { Icon, IconName, IconTile, InitialsTile } from "../ui/Icon";
import { Split } from "../ui/Layout";
import { Page, PageHeader } from "../ui/PageHeader";
import { Stepper } from "../ui/Stepper";
import { useCopyLink } from "../widgets/copyLink";
import type { PageProps } from "../widgets/page";

type Line = { description: string; quantity: string; unit: string; price: string; vat: string };
type CustomerForm = { id: number | null; name: string; street: string; postcode: string; city: string; email: string; is_business: boolean; language: string };
type Step = "note" | "details" | "check" | "done";

const STORE = "paidloop.newInvoice";
const STEPS: Step[] = ["note", "details", "check", "done"];
const EMPTY_CUSTOMER: CustomerForm = { id: null, name: "", street: "", postcode: "", city: "", email: "", is_business: true, language: "de" };
const MAX_TIMED_SECONDS = 3600; // a longer time means the work was left open, so it isn't a fair measure
const SEVERITY: Record<string, { icon: IconName; tag: "mustFix" | "lookAt" | "noteTag" }> = {
  error: { icon: "circle-x", tag: "mustFix" },
  warning: { icon: "triangle-exclamation-point", tag: "lookAt" },
  info: { icon: "info", tag: "noteTag" },
};

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function loadSaved(): any {
  try {
    return JSON.parse(window.sessionStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
}

export function NewInvoice({ hash, refresh }: PageProps) {
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
  // The uploaded photo, shown beside the fields. It lives only in this browser tab.
  const [photo, setPhoto] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null>(null);
  const skipStepFocus = useRef(true);

  const small = !!business?.small_business;
  const defaultVat = small ? "0" : "19";

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo);
  }, [photo]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per draft; the language only shapes the numbers when it opens
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a language switch should ask again
  }, [lang]);

  // Ctrl+Enter does the main action of the step while typing (read the note, check the invoice).
  const mainAction = useRef<() => void>(() => undefined);
  mainAction.current = step === "note" ? read : step === "details" ? saveAndCheck : () => undefined;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !(event.target as HTMLElement).closest("dialog")) {
        event.preventDefault();
        mainAction.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The demo clock's day; until it has loaded, today on this computer (local date, not UTC, so it is right after midnight too).
  const clock = () => todayIso || localToday();

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
    if (reading) return;
    if (!note.trim()) {
      setError(t("writeFirst"));
      return;
    }
    started();
    setReading(true);
    setError("");
    try {
      fill(await post("/api/capture/text", { text: note }));
      setPhoto(null);
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
      setPhoto(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
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
    setPhoto(null);
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
    setPhoto(null);
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
    focusAfter.current = null;
    window.setTimeout(() => document.getElementById("add-item")?.focus(), 0);
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
  const toFix = check?.issues.filter((item: any) => item.severity === "error").length || 0;
  const source =
    capture?.read_from === "photo_ai" ? { icon: "image" as const, text: t("readFromPhotoAi") }
    : capture?.read_from === "photo_basic" ? { icon: "image" as const, text: t("readFromPhotoBasic") }
    : capture?.source === "ai" ? { icon: "sparkles" as const, text: t("readByAi") }
    : capture ? { icon: "list-checks" as const, text: t("readByRules") }
    : { icon: "pencil" as const, text: t("enteredByHand") };
  // With a photo, the fields and the photo sit side by side, so each value can be compared.
  const besidePhoto = (content: ReactNode) =>
    photo ? (
      <Split
        main={content}
        side={
          <SectionCard title={t("photoTitle")} subtitle={t("photoSub")} icon="image">
            <img className="photo-preview" src={photo} alt={t("photoAlt")} />
          </SectionCard>
        }
      />
    ) : (
      content
    );

  return (
    <Page template="wizard">
      <PageHeader
        title={t("newInvoice")}
        actions={
          step !== "note" && step !== "done" ? (
            <Button tone="ghost" icon="refresh-cw" onClick={startOver}>
              {t("startOver")}
            </Button>
          ) : undefined
        }
      />

      <Stepper steps={[t("stepNote"), t("stepDetails"), t("stepCheck"), t("stepDone")]} current={stepIndex} label={t("stepsLabel")} />

      {restored && step !== "done" && (
        <Alert tone="info" icon="file-pen" role="status">
          {t("draftRestored")}
        </Alert>
      )}
      {error && <ErrorBox text={error} />}

      {step === "note" && (
        <section
          className={cx("card", "dropzone", dragging && "dragging")}
          aria-labelledby="note-title"
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
          <div className="card-head">
            <div className="card-title">
              <IconTile name="scan-text" size="sm" />
              <div className="card-title-text">
                <h2 id="note-title" ref={heading} tabIndex={-1}>
                  {t("noteTitle")}
                </h2>
                <p className="card-sub">{dragging ? t("dropHere") : t("noteHint")}</p>
              </div>
            </div>
          </div>
          <label className="sr-only" htmlFor="job-note">
            {t("noteLabel")}
          </label>
          <textarea
            id="job-note"
            className="note-input"
            rows={5}
            value={note}
            maxLength={4000}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the note is the only thing to do on this step, so typing starts here
            autoFocus
            placeholder={t("noteExample")}
            onChange={(event) => {
              if (event.target.value) started();
              setNote(event.target.value);
              setError("");
            }}
          />
          <p className="drop-hint">
            <Icon name="cloud-upload" size="sm" />
            {t("dropHint")}
          </p>
          <div className="note-actions">
            <Button tone="primary" size="lg" icon="scan-text" busy={reading} pending={t("reading")} onClick={read}>
              {t("readNote")}
            </Button>
            <Button icon="upload" disabled={reading} onClick={() => fileInput.current?.click()}>
              {t("uploadFile")}
            </Button>
            <Button tone="ghost" icon="pencil" disabled={reading} onClick={byHand}>
              {t("byHand")}
            </Button>
            <Button tone="link" icon="lightbulb" disabled={reading} onClick={() => setNote(t("noteExample"))}>
              {t("useExample")}
            </Button>
            <kbd className="hint-key">Ctrl + Enter</kbd>
            <input ref={fileInput} type="file" hidden accept=".pdf,.png,.jpg,.jpeg" onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])} />
          </div>
          {reading && (
            <p className="muted small" role="status">
              {t("readingHint")}
            </p>
          )}
        </section>
      )}

      {step === "details" && (
        <>
          {besidePhoto(
          <section className="card" aria-labelledby="details-title">
            <div className="card-head">
              <h2 id="details-title" ref={heading} tabIndex={-1}>
                {t("detailsTitle")}
              </h2>
              <Badge icon={source.icon}>{source.text}</Badge>
            </div>
            {capture?.warnings?.map((warning: any) => (
              <Alert tone="warn" key={warning.en}>
                {warning[lang]}
              </Alert>
            ))}
            {unsure.length > 0 && <Alert tone="warn">{t("unsureNote")}</Alert>}

            <div className="form-section">
              <h3 className="section-label">{t("customerSection")}</h3>
              {customer.id && !customerOpen ? (
                <div className="known">
                  <InitialsTile name={customer.name} />
                  <div className="known-text">
                    <span className="eyebrow">{t("knownCustomer")}</span>
                    <strong>{customer.name}</strong>
                    <span className="small muted">{[customer.street, [customer.postcode, customer.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span>
                    <span className="small muted">
                      {customer.email || t("noEmailYet")} · {customer.is_business ? t("typeBusiness") : t("typePrivate")} · {customer.language === "en" ? t("langEnglish") : t("langGerman")}
                    </span>
                  </div>
                  <div className="button-row">
                    <Button size="sm" icon="pencil" onClick={() => setCustomerOpen(true)}>
                      {t("editDetails")}
                    </Button>
                    <Button
                      size="sm"
                      tone="ghost"
                      onClick={() => {
                        setCustomer({ ...EMPTY_CUSTOMER, language: lang });
                        setCustomerOpen(true);
                        focusAfter.current = "buyer.name";
                      }}
                    >
                      {t("chooseAnother")}
                    </Button>
                  </div>
                </div>
              ) : (
                <FieldGrid columns={3}>
                  <Field id="buyer.name" label={t("customerName")} help={customer.id ? undefined : t("customerNameHint")} unsure={flag("customer_name")} error={fieldErrors["buyer.name"]} emphasis>
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
                    <input value={customer.street} onChange={(event) => setCustomerField({ street: event.target.value })} />
                  </Field>
                  <div className="field-pair">
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
                  <Field id="buyer.language" label={t("customerLanguage")} help={t("customerLanguageHint")}>
                    <select value={customer.language} onChange={(event) => setCustomerField({ language: event.target.value })}>
                      <option value="de">{t("langGerman")}</option>
                      <option value="en">{t("langEnglish")}</option>
                    </select>
                  </Field>
                </FieldGrid>
              )}
            </div>

            <div className="form-section">
              <h3 className="section-label">{t("workSection")}</h3>
              <div className="lines">
                <div className="lines-head" aria-hidden="true">
                  <span>{t("what")}</span>
                  <span>{t("qty")}</span>
                  <span>{t("unit")}</span>
                  <span>{t("netPrice")}</span>
                  <span>{t("vatPercent")}</span>
                  <span className="num">{t("lineTotal")}</span>
                  <span />
                </div>
                {lines.map((line, index) => {
                  const position = index + 1;
                  return (
                    <div className="line" key={index}>
                      <Field
                        id={`lines.${position}.description`}
                        label={t("what")}
                        labelHidden="md"
                        unsure={flag(`lines.${index}.description`)}
                        error={fieldErrors[`lines.${position}.description`]}
                      >
                        <input value={line.description} onChange={(event) => setLine(index, { description: event.target.value })} />
                      </Field>
                      <Field id={`lines.${position}.quantity`} label={t("qty")} labelHidden="md" unsure={flag(`lines.${index}.quantity`)} error={fieldErrors[`lines.${position}.quantity`]}>
                        <input inputMode="decimal" value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })} />
                      </Field>
                      <Field id={`lines.${position}.unit`} label={t("unit")} labelHidden="md">
                        <select value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })}>
                          <option value="HUR">{t("unitHours")}</option>
                          <option value="H87">{t("unitPieces")}</option>
                        </select>
                      </Field>
                      <Field id={`lines.${position}.price`} label={t("netPrice")} labelHidden="md" unsure={flag(`lines.${index}.unit_price`)} error={fieldErrors[`lines.${position}.price`]}>
                        <input inputMode="decimal" value={line.price} onChange={(event) => setLine(index, { price: event.target.value })} />
                      </Field>
                      <Field id={`lines.${position}.vat`} label={t("vatPercent")} labelHidden="md" error={fieldErrors[`lines.${position}.vat`]}>
                        {small ? (
                          <select disabled value="0">
                            <option value="0">0</option>
                          </select>
                        ) : (
                          <select value={line.vat} onChange={(event) => setLine(index, { vat: event.target.value })}>
                            <option value="19">19</option>
                            <option value="7">7</option>
                          </select>
                        )}
                      </Field>
                      <div className="line-net">
                        <span className="line-net-label">{t("lineTotal")}</span>
                        <strong>{eur(computed[index]?.net || 0)}</strong>
                      </div>
                      <Button tone="ghost" icon="trash" iconOnly className="line-remove" onClick={() => removeLine(index)}>
                        {t("removeItemLabel", { n: position })}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <div className="button-row">
                <Button
                  id="add-item"
                  icon="plus"
                  onClick={() => {
                    setLines((all) => [...all, emptyLine()]);
                    focusAfter.current = null;
                    window.setTimeout(() => document.getElementById(`lines.${lines.length + 1}.description`)?.focus(), 0);
                  }}
                >
                  {t("addItem")}
                </Button>
                {small && <Badge icon="info">{t("smallBusinessNoVat")}</Badge>}
              </div>
            </div>

            <div className="form-section">
              <h3 className="section-label">{t("datesSection")}</h3>
              <FieldGrid columns={3}>
                <Field id="issue_date" label={t("invoiceDate")} error={fieldErrors["issue_date"]}>
                  <input type="date" value={dates.issue} onChange={(event) => (setDates({ ...dates, issue: event.target.value }), clearField("issue_date"))} />
                </Field>
                <div className="field-with-chips">
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
                      <Button
                        key={label}
                        size="sm"
                        onClick={() => {
                          setDates({ ...dates, service: addDays(clock(), shift as number) });
                          setUnsure((u) => u.filter((f) => f !== "service_date"));
                          clearField("service_date");
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="field-with-chips">
                  <Field id="due_date" label={t("paymentDue")} error={fieldErrors["due_date"]}>
                    <input type="date" value={dates.due} onChange={(event) => (setDates({ ...dates, due: event.target.value }), clearField("due_date"))} />
                  </Field>
                  <div className="date-chips">
                    {[7, 14, 30].map((days) => (
                      <Button
                        key={days}
                        size="sm"
                        onClick={() => {
                          setDates({ ...dates, due: addDays(dates.issue || clock(), days) });
                          clearField("due_date");
                        }}
                      >
                        {t("inDays", { n: days })}
                      </Button>
                    ))}
                  </div>
                </div>
              </FieldGrid>
              <Switch id="property-work" label={t("propertyWork")} checked={propertyWork} onChange={(event) => setPropertyWork(event.target.checked)} />
            </div>
          </section>,
          )}

          <div className="action-bar">
            <Button tone="ghost" icon="arrow-left" onClick={() => setStep("note")}>
              {t("back")}
            </Button>
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
            <Button tone="primary" size="lg" iconEnd="arrow-right" busy={busy} pending={t("checking")} disabled={lines.length === 0} onClick={saveAndCheck}>
              {t("checkInvoice")}
            </Button>
          </div>
        </>
      )}

      {step === "check" && check && (
        <>
          <Split
            main={
              <section className="card" aria-labelledby="check-title">
                <div className="card-head">
                  <h2 id="check-title" ref={heading} tabIndex={-1}>
                    {t("checkTitle")}
                  </h2>
                  {toFix > 0 ? (
                    <Badge tone="bad" icon="circle-x">
                      {t("toFixCount", { n: toFix })}
                    </Badge>
                  ) : (
                    <Badge tone="good" icon="circle-check">
                      {t("readyToIssue")}
                    </Badge>
                  )}
                </div>
                {check.issues.length === 0 && <Alert tone="good">{t("noProblems")}</Alert>}
                {check.issues.length > 0 && (
                  <ul className="issues">
                    {check.issues.map((issue: any) => {
                      const seller = issue.field.startsWith("seller");
                      const target = targetOf(issue.field);
                      const kind = SEVERITY[issue.severity] || SEVERITY.info;
                      return (
                        <li key={`${issue.rule_id}-${issue.field}`} className={cx("issue", issue.severity)}>
                          <span className="issue-icon">
                            <Icon name={kind.icon} />
                          </span>
                          <div className="issue-body">
                            <span className="issue-tag">{t(kind.tag)}</span>
                            <strong>{issue.message}</strong>
                            <span className="small">{issue.fix}</span>
                            <span className="muted small">{issue.law}</span>
                          </div>
                          {issue.severity === "error" &&
                            (seller ? (
                              <ButtonLink size="sm" icon="settings" href="#/settings">
                                {t("openSettings")}
                              </ButtonLink>
                            ) : target ? (
                              <Button size="sm" icon="pencil" onClick={() => goToField(issue.field)}>
                                {t("goToField")}
                              </Button>
                            ) : null)}
                        </li>
                      );
                    })}
                  </ul>
                )}
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
            }
            side={
              check.can_issue && (
                <SectionCard title={t("summary")} icon="receipt-text">
                  <dl className="facts">
                    <dt>{t("customer")}</dt>
                    <dd>{customer.name}</dd>
                    <dt>{t("sentTo")}</dt>
                    <dd>{customer.email || "-"}</dd>
                    <dt>{t("invoiceLanguage")}</dt>
                    <dd>{customer.language === "en" ? t("langEnglish") : t("langGerman")}</dd>
                    <dt>{t("paymentDue")}</dt>
                    <dd>{day(dates.due)}</dd>
                    <dt>{t("net")}</dt>
                    <dd className="tabular">{eur(sums.net)}</dd>
                    <dt>{t("vat")}</dt>
                    <dd className="tabular">{eur(sums.vat)}</dd>
                    <dt className="strong">{t("total")}</dt>
                    <dd className="tabular strong">{eur(sums.gross)}</dd>
                  </dl>
                  <p className="muted small">{t("issueHint")}</p>
                </SectionCard>
              )
            }
          />

          <div className="action-bar">
            <Button tone="ghost" icon="arrow-left" onClick={() => setStep("details")}>
              {t("back")}
            </Button>
            {check.can_issue ? (
              <Button tone="primary" size="lg" icon="send" busy={busy} pending={t("issuing")} onClick={issue}>
                {t("issueInvoice")}
              </Button>
            ) : (
              <>
                <span className="action-note">
                  <Icon name="triangle-exclamation-point" size="sm" />
                  {t("fixFirst")}
                </span>
                {firstFixable ? (
                  <Button tone="primary" size="lg" icon="pencil" onClick={() => goToField(firstFixable.field)}>
                    {t("goToField")}
                  </Button>
                ) : (
                  <Button tone="primary" size="lg" icon="refresh-cw" busy={busy} pending={t("checking")} onClick={saveAndCheck}>
                    {t("checkAgain")}
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {step === "done" && issued && (
        <section className="card done-card" aria-labelledby="done-title">
          <EmptyState
            icon="circle-check"
            tone="good"
            heading
            titleId="done-title"
            title={t("doneTitle", { number: issued.number })}
            hint={
              <>
                {t("doneNext")} {elapsed !== null && t("doneTime", { time: duration(elapsed) })}
              </>
            }
            action={
              <div className="button-row center-row">
                <ButtonLink tone="primary" icon="download" href={`/api/invoices/${issued.id}/pdf`}>
                  {t("downloadPdf")}
                </ButtonLink>
                <Button icon="copy" onClick={() => copyLink(customerLink(issued.public_token))}>
                  {t("copyLink")}
                </Button>
                <ButtonLink icon="receipt-text" href={`#/invoices/${issued.id}`}>
                  {t("openInvoice")}
                </ButtonLink>
                <Button tone="ghost" icon="file-plus" onClick={startOver}>
                  {t("anotherInvoice")}
                </Button>
              </div>
            }
          />
          <span className="sr-only">{labels.status[issued.status]}</span>
        </section>
      )}
    </Page>
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
