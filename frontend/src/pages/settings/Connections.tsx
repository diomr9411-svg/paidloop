// Settings > Connections: each owner sets their own PayPal sandbox keys and local AI here, instead of a file.
// Every card saves itself. The secret goes to the server and never comes back; the screen only learns its last characters.
import { useEffect, useState } from "react";

import { api, ApiError, del, post, put } from "../../api";
import { Key, useT } from "../../i18n";
import { Alert, ErrorBox } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import { Button, ButtonLink } from "../../ui/Button";
import { SectionCard } from "../../ui/Card";
import { ConfirmButton } from "../../ui/Dialog";
import { Field, FieldGrid, Switch } from "../../ui/Field";
import { SectionSkeleton } from "../../ui/Loading";
import { useToast } from "../../ui/Toast";

type Source = "app" | "env" | "none";

interface View {
  paypal: {
    source: Source;
    mode: string;
    secret_unreadable: boolean;
    client_id: string;
    secret_set: boolean;
    secret_hint: string;
    webhook_id: string;
    buyer_email: string;
  };
  ai: { source: Source; enabled: boolean; base_url: string; model: string; cpu_only: boolean };
}

type PaypalCheck = { ok: boolean; code: "ok" | "missing" | "refused" | "unreachable" | "error" };
type AiCheck = { ok: boolean; code: "ok" | "off" | "unreachable" | "model_missing"; models: string[] };

const PAYPAL_RESULT: Record<PaypalCheck["code"], Key> = {
  ok: "checkOk",
  refused: "checkRefused",
  unreachable: "checkUnreachable",
  missing: "checkMissing",
  error: "checkError",
};

/** Where the keys in use come from, as a badge with a word. */
function SourceBadge({ source, noneKey }: { source: Source; noneKey: Key }) {
  const { t } = useT();
  if (source === "none")
    return (
      <Badge tone="warn" icon="plug">
        {t(noneKey)}
      </Badge>
    );
  return (
    <Badge tone="good" icon="circle-check">
      {t(source === "app" ? "sourceApp" : "sourceEnv")}
    </Badge>
  );
}

export function Connections({ refresh }: { refresh: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api<View>("/api/connections")
      .then((data) => {
        setView(data);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [attempt]);

  // A link from the status menu or Home lands here.
  useEffect(() => {
    if (view && window.location.hash === "#/settings/connections") document.getElementById("connections")?.scrollIntoView({ block: "start" });
  }, [view]);

  if (error && !view) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!view) return <SectionSkeleton lines={6} />;

  const saved = (next: View) => {
    setView(next);
    refresh();
  };
  return (
    <>
      <PaypalCard view={view} onSaved={saved} />
      <AiCard view={view} onSaved={saved} />
    </>
  );
}

function PaypalCard({ view, onSaved }: { view: View; onSaved: (view: View) => void }) {
  const { t } = useT();
  const toast = useToast();
  const p = view.paypal;
  const [form, setForm] = useState({ client_id: p.client_id, client_secret: "", webhook_id: p.webhook_id, buyer_email: p.buyer_email });
  const [bad, setBad] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "test" | "save" | "remove">("");
  const [result, setResult] = useState<PaypalCheck | null>(null);
  const [error, setError] = useState("");

  const change = (key: keyof typeof form, value: string) => {
    setForm({ ...form, [key]: value });
    setBad((all) => all.filter((name) => name !== key));
    setResult(null);
  };
  const problem = (key: string) => (bad.includes(key) ? (key === "client_secret" ? t("checkMissing") : t("invalidValue")) : undefined);

  async function run(kind: "test" | "save" | "remove") {
    setBusy(kind);
    setError("");
    setBad([]);
    setResult(null);
    try {
      if (kind === "test") {
        setResult(await post<PaypalCheck>("/api/connections/paypal/test", { client_id: form.client_id, client_secret: form.client_secret }));
      } else if (kind === "save") {
        const next = await put<View & { test: PaypalCheck }>("/api/connections/paypal", form);
        setResult(next.test);
        setForm({ ...form, client_secret: "" });
        toast(t("saved"));
        onSaved(next);
      } else {
        const next = await del<View>("/api/connections/paypal");
        setForm({ client_id: next.paypal.client_id, client_secret: "", webhook_id: next.paypal.webhook_id, buyer_email: next.paypal.buyer_email });
        toast(t("saved"));
        onSaved(next);
      }
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) setBad(e.fields);
    } finally {
      setBusy("");
    }
  }

  const secretNote = p.secret_unreadable ? t("secretUnreadable") : p.secret_set && p.secret_hint ? t("secretKeep", { hint: p.secret_hint }) : undefined;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run("save");
      }}
    >
      <SectionCard
        id="connections"
        title={t("paypalTitle")}
        subtitle={t("connectionsHint")}
        icon="credit-card"
        actions={
          <div className="badge-row">
            <SourceBadge source={p.source} noneKey="sourceNone" />
            <Badge tone="info" icon="info">
              {t("sandboxOnly")}
            </Badge>
          </div>
        }
        footer={
          <>
            {p.source === "app" && (
              <ConfirmButton
                tone="danger"
                icon="trash"
                label={t("removeSaved")}
                title={t("removeSavedTitle")}
                body={t("removeSavedHint")}
                confirmLabel={t("removeSavedConfirm")}
                disabled={busy !== ""}
                onConfirm={() => run("remove")}
              />
            )}
            <Button icon="plug" disabled={busy !== ""} busy={busy === "test"} pending={t("testing")} onClick={() => run("test")}>
              {t("testKeys")}
            </Button>
            <Button type="submit" tone="primary" icon="check" disabled={busy !== ""} busy={busy === "save"} pending={t("connecting")}>
              {t("saveConnect")}
            </Button>
          </>
        }
      >
        <p className="small where-keys">
          {t("paypalWhere")}{" "}
          <ButtonLink tone="link" href="https://developer.paypal.com/dashboard/" external>
            {t("paypalWhereLink")}
          </ButtonLink>
        </p>
        <FieldGrid>
          <Field id="paypal-client_id" label={t("clientId")} error={problem("client_id")}>
            <input value={form.client_id} onChange={(event) => change("client_id", event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="paypal-client_secret" label={t("clientSecret")} note={secretNote} error={problem("client_secret")}>
            <input type="password" value={form.client_secret} onChange={(event) => change("client_secret", event.target.value)} autoComplete="new-password" spellCheck={false} />
          </Field>
          <Field id="paypal-webhook_id" label={t("webhookId")} help={t("webhookIdHint")} error={problem("webhook_id")}>
            <input value={form.webhook_id} onChange={(event) => change("webhook_id", event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            id="paypal-buyer_email"
            label={t("buyerEmail")}
            help={t("buyerEmailHint")}
            note={/@/.test(form.buyer_email) && !/\.example\.com\s*$/i.test(form.buyer_email) ? t("buyerEmailNotSandbox") : undefined}
            error={problem("buyer_email")}
          >
            <input type="email" value={form.buyer_email} onChange={(event) => change("buyer_email", event.target.value)} autoComplete="off" />
          </Field>
        </FieldGrid>
        {result && (
          <Alert tone={result.ok ? "good" : "bad"} role="status">
            {t(PAYPAL_RESULT[result.code])}
          </Alert>
        )}
        {error && <ErrorBox text={error} />}
        <p className="muted small">{t("switchWarning")}</p>
      </SectionCard>
    </form>
  );
}

function AiCard({ view, onSaved }: { view: View; onSaved: (view: View) => void }) {
  const { t } = useT();
  const toast = useToast();
  const a = view.ai;
  const [form, setForm] = useState({ enabled: a.enabled, base_url: a.base_url || "http://localhost:11434", model: a.model, cpu_only: a.cpu_only });
  const [models, setModels] = useState<string[]>([]);
  const [bad, setBad] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "find" | "save" | "remove">("");
  const [result, setResult] = useState<AiCheck | null>(null);
  const [error, setError] = useState("");

  const change = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm({ ...form, [key]: value });
    setBad((all) => all.filter((name) => name !== key));
    setResult(null);
  };
  const problem = (key: string) => (bad.includes(key) ? t("invalidValue") : undefined);

  async function run(kind: "find" | "save" | "remove") {
    setBusy(kind);
    setError("");
    setBad([]);
    setResult(null);
    try {
      if (kind === "find") {
        const found = await post<AiCheck>("/api/connections/ai/test", { base_url: form.base_url });
        setModels(found.models);
        setResult(found);
        if (!form.model && found.models.length) setForm({ ...form, model: found.models[0] });
      } else if (kind === "save") {
        const next = await put<View & { test: AiCheck }>("/api/connections/ai", form);
        if (next.test.models.length) setModels(next.test.models);
        setResult(next.test);
        toast(t("saved"));
        onSaved(next);
      } else {
        const next = await del<View>("/api/connections/ai");
        setForm({ enabled: next.ai.enabled, base_url: next.ai.base_url, model: next.ai.model, cpu_only: next.ai.cpu_only });
        toast(t("saved"));
        onSaved(next);
      }
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) setBad(e.fields);
    } finally {
      setBusy("");
    }
  }

  let resultText = "";
  if (result) {
    if (result.code === "ok") resultText = result.models.length ? t("aiOkModels", { models: result.models.join(", ") }) : t("aiNoModels");
    else if (result.code === "off") resultText = t("aiSavedOff");
    else if (result.code === "model_missing") resultText = t("aiModelMissing", { model: form.model });
    else resultText = t("aiUnreachable");
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run("save");
      }}
    >
      <SectionCard
        title={t("aiTitle")}
        subtitle={t("aiUseHint")}
        icon="cpu"
        actions={<SourceBadge source={a.source} noneKey="aiSourceNone" />}
        footer={
          <>
            {a.source === "app" && (
              <ConfirmButton
                tone="danger"
                icon="trash"
                label={t("removeSaved")}
                title={t("removeAiTitle")}
                body={t("removeAiHint")}
                confirmLabel={t("removeSavedConfirm")}
                disabled={busy !== ""}
                onConfirm={() => run("remove")}
              />
            )}
            <Button icon="search" disabled={busy !== "" || !form.enabled} busy={busy === "find"} pending={t("testing")} onClick={() => run("find")}>
              {t("findModels")}
            </Button>
            <Button type="submit" tone="primary" icon="check" disabled={busy !== ""} busy={busy === "save"} pending={t("saving")}>
              {t("saveAi")}
            </Button>
          </>
        }
      >
        <Switch id="ai-enabled" label={t("aiUse")} checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)} />
        <FieldGrid>
          <Field id="ai-base_url" label={t("aiAddress")} error={problem("base_url")}>
            <input value={form.base_url} onChange={(event) => change("base_url", event.target.value)} autoComplete="off" spellCheck={false} disabled={!form.enabled} />
          </Field>
          <Field id="ai-model" label={t("aiModel")} help={t("aiModelHint")} error={problem("model")}>
            <input value={form.model} onChange={(event) => change("model", event.target.value)} list="ai-models" autoComplete="off" spellCheck={false} disabled={!form.enabled} />
          </Field>
        </FieldGrid>
        <datalist id="ai-models">
          {models.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Switch id="ai-cpu_only" label={t("aiCpuOnly")} checked={form.cpu_only} onChange={(event) => change("cpu_only", event.target.checked)} disabled={!form.enabled} />
        {result && (
          <Alert tone={result.ok ? "good" : "bad"} role="status">
            {resultText}
          </Alert>
        )}
        {error && <ErrorBox text={error} />}
      </SectionCard>
    </form>
  );
}
