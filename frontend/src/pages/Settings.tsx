import { FormEvent, useEffect, useState } from "react";

import { api, ApiError, put } from "../api";
import { Key, useT } from "../i18n";
import { ErrorBox } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { Field, FieldGrid, Switch } from "../ui/Field";
import { CardGrid } from "../ui/Layout";
import { Loading } from "../ui/Loading";
import { Page, PageHeader } from "../ui/PageHeader";
import { useToast } from "../ui/Toast";
import type { PageProps } from "../widgets/page";
import { Connections } from "./settings/Connections";

const BUSINESS_FIELDS = ["name", "email", "street", "postcode", "city", "vat_id", "tax_number", "vat_method", "small_business"];
const LIMIT_FIELDS = ["max_installments", "min_first_payment_pct", "max_plan_days", "min_installment_eur", "reminder_gap_days", "payment_days"];

type Business = Record<string, any>;

/**
 * One settings card that saves itself. It keeps its own unsaved edits; saving sends the last saved
 * business record with only this card's fields changed, so the other card's unsaved edits stay its own.
 */
function useCard(saved: Business | null, fields: string[], onSaved: (next: Business) => void) {
  const { t } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Business>({});
  const [bad, setBad] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = (key: string) => (key in draft ? draft[key] : saved?.[key]);
  const dirty = Object.keys(draft).some((key) => draft[key] !== saved?.[key]);

  return {
    value,
    dirty,
    busy,
    error,
    problem: (key: string) => (bad.includes(key) ? t("invalidValue") : undefined),
    change(key: string, next: unknown) {
      setDraft((all) => ({ ...all, [key]: next }));
      setBad((all) => all.filter((name) => name !== key));
    },
    async save() {
      if (!saved) return;
      setBusy(true);
      setError("");
      setBad([]);
      try {
        const body = { ...saved, ...Object.fromEntries(fields.filter((key) => key in draft).map((key) => [key, draft[key]])) };
        const next = await put<Business>("/api/business", body);
        setDraft({});
        onSaved(next);
        toast(t("saved"));
      } catch (e) {
        setError((e as Error).message);
        if (e instanceof ApiError) setBad(e.fields.filter((name) => fields.includes(name)));
      } finally {
        setBusy(false);
      }
    },
  };
}

function SaveFooter({ card }: { card: ReturnType<typeof useCard> }) {
  const { t } = useT();
  return (
    <>
      {card.dirty && (
        <Badge tone="info" icon="pencil">
          {t("unsavedChanges")}
        </Badge>
      )}
      <Button type="submit" tone="primary" icon="check" busy={card.busy} pending={t("saving")} disabled={!card.dirty}>
        {t("save")}
      </Button>
    </>
  );
}

export function Settings({ refresh }: PageProps) {
  const { t } = useT();
  const [saved, setSaved] = useState<Business | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api<Business>("/api/business")
      .then((data) => {
        setSaved(data);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [attempt]);

  const onSaved = (next: Business) => {
    setSaved(next);
    refresh();
  };
  const business = useCard(saved, BUSINESS_FIELDS, onSaved);
  const limits = useCard(saved, LIMIT_FIELDS, onSaved);

  if (error && !saved) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!saved) return <Loading shape="form" title={t("settings")} />;

  const text = (key: string, label: Key, help?: Key) => (
    <Field id={`business-${key}`} label={t(label)} help={help ? t(help) : undefined} error={business.problem(key)}>
      <input value={business.value(key) ?? ""} onChange={(event) => business.change(key, event.target.value)} />
    </Field>
  );
  const number = (key: string, label: Key, help: Key) => (
    <Field id={`business-${key}`} label={t(label)} help={t(help)} error={limits.problem(key)}>
      <input type="number" value={limits.value(key) ?? ""} onChange={(event) => limits.change(key, event.target.value === "" ? "" : Number(event.target.value))} />
    </Field>
  );
  const submit = (card: ReturnType<typeof useCard>) => (event: FormEvent) => {
    event.preventDefault();
    card.save();
  };

  return (
    <Page template="settings">
      <PageHeader title={t("settings")} info={t("settingsIntro")} />
      <CardGrid>
        <form onSubmit={submit(business)}>
          <SectionCard title={t("yourBusiness")} subtitle={t("yourBusinessHint")} icon="store" footer={<SaveFooter card={business} />}>
            <FieldGrid>
              {text("name", "name")}
              {text("email", "emailPlain")}
              {text("street", "street")}
              <div className="field-pair">
                {text("postcode", "postcode")}
                {text("city", "city")}
              </div>
              {text("vat_id", "vatId")}
              {text("tax_number", "taxNumber")}
              <Field id="business-vat_method" label={t("vatMethod")} className="full">
                <select value={business.value("vat_method")} onChange={(event) => business.change("vat_method", event.target.value)}>
                  <option value="soll">{t("vatSoll")}</option>
                  <option value="ist">{t("vatIst")}</option>
                </select>
              </Field>
              <Switch id="business-small_business" className="grid-switch" label={t("smallBusiness")} checked={!!business.value("small_business")} onChange={(event) => business.change("small_business", event.target.checked)} />
            </FieldGrid>
            {business.error && <ErrorBox text={business.error} />}
          </SectionCard>
        </form>
        <form onSubmit={submit(limits)}>
          <SectionCard title={t("agentLimits")} subtitle={t("agentLimitsHint")} icon="gauge" footer={<SaveFooter card={limits} />}>
            <FieldGrid columns={3}>
              {number("max_installments", "maxInstallments", "maxInstallmentsHint")}
              {number("min_first_payment_pct", "minFirst", "minFirstHint")}
              {number("max_plan_days", "maxPlanDays", "maxPlanDaysHint")}
              {number("min_installment_eur", "minInstallment", "minInstallmentHint")}
              {number("reminder_gap_days", "reminderGap", "reminderGapHint")}
              {number("payment_days", "paymentDays", "paymentDaysHint")}
            </FieldGrid>
            {limits.error && <ErrorBox text={limits.error} />}
          </SectionCard>
        </form>
        <Connections refresh={refresh} />
      </CardGrid>
    </Page>
  );
}
