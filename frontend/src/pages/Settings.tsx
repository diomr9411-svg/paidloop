import { useEffect, useState } from "react";

import { api, ApiError, put } from "../api";
import { ErrorBox, Field, Loading, useToast } from "../components";
import { Key, useT } from "../i18n";

export function Settings({ refresh }: { refresh: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api("/api/business")
      .then((data) => {
        setForm(data);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [attempt]);

  if (error && !form) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!form) return <Loading />;

  const change = (key: string, value: unknown) => {
    setForm({ ...form, [key]: value });
    setBad((all) => all.filter((name) => name !== key));
    setDirty(true);
  };
  const problem = (key: string) => (bad.includes(key) ? t("invalidValue") : undefined);

  const text = (key: string, label: Key) => (
    <Field id={`business-${key}`} label={t(label)} error={problem(key)}>
      <input value={form[key] ?? ""} onChange={(event) => change(key, event.target.value)} />
    </Field>
  );
  const number = (key: string, label: Key, hint: Key) => (
    <Field id={`business-${key}`} label={t(label)} hint={t(hint)} error={problem(key)}>
      <input type="number" value={form[key]} onChange={(event) => change(key, event.target.value === "" ? "" : Number(event.target.value))} />
    </Field>
  );

  async function save() {
    setBusy(true);
    setError("");
    setBad([]);
    try {
      setForm(await put("/api/business", form));
      setDirty(false);
      toast(t("saved"));
      refresh();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) setBad(e.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h1>{t("settings")}</h1>
      <section className="card">
        <h2>{t("yourBusiness")}</h2>
        <div className="form-grid">
          {text("name", "name")}
          {text("email", "emailPlain")}
          {text("street", "street")}
          <div className="form-pair">
            {text("postcode", "postcode")}
            {text("city", "city")}
          </div>
          {text("vat_id", "vatId")}
          {text("tax_number", "taxNumber")}
          <Field id="business-vat_method" label={t("vatMethod")}>
            <select value={form.vat_method} onChange={(event) => change("vat_method", event.target.value)}>
              <option value="soll">{t("vatSoll")}</option>
              <option value="ist">{t("vatIst")}</option>
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.small_business} onChange={(event) => change("small_business", event.target.checked)} />
            {t("smallBusiness")}
          </label>
        </div>
      </section>
      <section className="card">
        <h2>{t("agentLimits")}</h2>
        <p className="muted">{t("agentLimitsHint")}</p>
        <div className="form-grid">
          {number("max_installments", "maxInstallments", "maxInstallmentsHint")}
          {number("min_first_payment_pct", "minFirst", "minFirstHint")}
          {number("max_plan_days", "maxPlanDays", "maxPlanDaysHint")}
          {number("min_installment_eur", "minInstallment", "minInstallmentHint")}
          {number("reminder_gap_days", "reminderGap", "reminderGapHint")}
          {number("payment_days", "paymentDays", "paymentDaysHint")}
        </div>
      </section>
      {error && <ErrorBox text={error} />}
      <div className="action-bar">
        <span />
        <button className="primary big" disabled={busy || !dirty} aria-busy={busy}>
          {t("saveSettings")}
        </button>
      </div>
    </form>
  );
}
