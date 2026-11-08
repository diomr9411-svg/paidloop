// Settings > Connections: each owner sets their own PayPal sandbox keys and local AI here, instead of a file.
// Every card saves itself. The secret goes to the server and never comes back; the screen only learns its last characters.
import { useEffect, useState } from "react";

import { api, ApiError, del, post, put } from "../api";
import { BusyLabel, ErrorBox, Field, TwoStepButton, useToast } from "../components";
import { Key, useT } from "../i18n";

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

/** A result says what happened in words, with a mark, so it never depends on colour alone. */
function Result({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={`alert ${ok ? "good" : "error"}`} role="status">
      <span aria-hidden="true">{ok ? "✓ " : "! "}</span>
      {text}
    </p>
  );
}

function SourceLine({ source, noneKey }: { source: Source; noneKey: Key }) {
  const { t } = useT();
  const key: Key = source === "app" ? "sourceApp" : source === "env" ? "sourceEnv" : noneKey;
  return <span className={`pill ${source === "none" ? "warn" : "good"}`}>{t(key)}</span>;
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

  // A link from the status light or Home lands here.
  useEffect(() => {
    if (view && window.location.hash === "#/settings/connections") document.getElementById("connections")?.scrollIntoView({ block: "start" });
  }, [view]);

  if (error && !view) return <ErrorBox text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!view) return null;

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

  const secretHint = p.secret_unreadable ? t("secretUnreadable") : p.secret_set && p.secret_hint ? t("secretKeep", { hint: p.secret_hint }) : undefined;

  return (
    <section className="card connection-card" id="connections" aria-labelledby="paypal-title">
      <div className="title-row">
        <h2 id="paypal-title">{t("paypalTitle")}</h2>
        <div className="chips">
          <SourceLine source={p.source} noneKey="sourceNone" />
          <span className="pill info">{t("sandboxOnly")}</span>
        </div>
      </div>
      <p className="muted">{t("connectionsHint")}</p>
      <p className="small">
        {t("paypalWhere")}{" "}
        <a href="https://developer.paypal.com/dashboard/" target="_blank" rel="noopener noreferrer">
          {t("paypalWhereLink")}
        </a>
      </p>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          run("save");
        }}
      >
        <Field id="paypal-client_id" label={t("clientId")} error={problem("client_id")}>
          <input value={form.client_id} onChange={(event) => change("client_id", event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field id="paypal-client_secret" label={t("clientSecret")} hint={secretHint} error={problem("client_secret")}>
          <input type="password" value={form.client_secret} onChange={(event) => change("client_secret", event.target.value)} autoComplete="new-password" spellCheck={false} />
        </Field>
        <Field id="paypal-webhook_id" label={t("webhookId")} hint={t("webhookIdHint")} error={problem("webhook_id")}>
          <input value={form.webhook_id} onChange={(event) => change("webhook_id", event.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field id="paypal-buyer_email" label={t("buyerEmail")} hint={t("buyerEmailHint")} error={problem("buyer_email")}>
          <input type="email" value={form.buyer_email} onChange={(event) => change("buyer_email", event.target.value)} autoComplete="off" />
        </Field>
        <div className="button-row full">
          <button type="submit" className="primary" disabled={busy !== ""} aria-busy={busy === "save"}>
            <BusyLabel busy={busy === "save"} label={t("saveConnect")} pending={t("connecting")} />
          </button>
          <button type="button" disabled={busy !== ""} aria-busy={busy === "test"} onClick={() => run("test")}>
            <BusyLabel busy={busy === "test"} label={t("testKeys")} pending={t("testing")} />
          </button>
          {p.source === "app" && (
            <TwoStepButton label={t("removeSaved")} confirmLabel={t("removeSavedConfirm")} hint={t("removeSavedHint")} disabled={busy !== ""} onConfirm={() => run("remove")} />
          )}
        </div>
      </form>
      {result && <Result ok={result.ok} text={t(PAYPAL_RESULT[result.code])} />}
      {error && <ErrorBox text={error} />}
      <p className="muted small">{t("switchWarning")}</p>
    </section>
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
    <section className="card connection-card" aria-labelledby="ai-title">
      <div className="title-row">
        <h2 id="ai-title">{t("aiTitle")}</h2>
        <SourceLine source={a.source} noneKey="aiSourceNone" />
      </div>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          run("save");
        }}
      >
        <label className="check full">
          <input type="checkbox" checked={form.enabled} onChange={(event) => change("enabled", event.target.checked)} aria-describedby="ai-use-hint" />
          {t("aiUse")}
        </label>
        <p className="field-hint full" id="ai-use-hint">
          {t("aiUseHint")}
        </p>
        <Field id="ai-base_url" label={t("aiAddress")} error={problem("base_url")}>
          <input value={form.base_url} onChange={(event) => change("base_url", event.target.value)} autoComplete="off" spellCheck={false} disabled={!form.enabled} />
        </Field>
        <Field id="ai-model" label={t("aiModel")} hint={t("aiModelHint")} error={problem("model")}>
          <input value={form.model} onChange={(event) => change("model", event.target.value)} list="ai-models" autoComplete="off" spellCheck={false} disabled={!form.enabled} />
        </Field>
        <datalist id="ai-models">
          {models.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <label className="check full">
          <input type="checkbox" checked={form.cpu_only} onChange={(event) => change("cpu_only", event.target.checked)} disabled={!form.enabled} />
          {t("aiCpuOnly")}
        </label>
        <div className="button-row full">
          <button type="submit" className="primary" disabled={busy !== ""} aria-busy={busy === "save"}>
            <BusyLabel busy={busy === "save"} label={t("saveAi")} pending={t("saving")} />
          </button>
          <button type="button" disabled={busy !== "" || !form.enabled} aria-busy={busy === "find"} onClick={() => run("find")}>
            <BusyLabel busy={busy === "find"} label={t("findModels")} pending={t("testing")} />
          </button>
          {a.source === "app" && (
            <TwoStepButton label={t("removeSaved")} confirmLabel={t("removeSavedConfirm")} hint={t("removeAiHint")} disabled={busy !== ""} onConfirm={() => run("remove")} />
          )}
        </div>
      </form>
      {result && <Result ok={result.ok} text={resultText} />}
      {error && <ErrorBox text={error} />}
    </section>
  );
}
