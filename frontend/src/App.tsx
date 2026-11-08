import { useCallback, useEffect, useRef, useState } from "react";

import { api, post } from "./api";
import { AppearanceMenu, BusyLabel, LangSwitch, ToastProvider, TwoStepButton, useToast } from "./components";
import { Key, LangProvider, useT } from "./i18n";
import { Approvals } from "./pages/Approvals";
import { Audit } from "./pages/Audit";
import { Dashboard } from "./pages/Dashboard";
import { InvoiceDetail } from "./pages/InvoiceDetail";
import { Invoices } from "./pages/Invoices";
import { NewInvoice } from "./pages/NewInvoice";
import { PayPage } from "./pages/PayPage";
import { Settings } from "./pages/Settings";

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const payMatch = hash.match(/^#\/pay\/([\w-]+)/);
  return (
    <LangProvider>
      <ToastProvider>{payMatch ? <PayPage token={payMatch[1]} /> : <OwnerApp hash={hash} />}</ToastProvider>
    </LangProvider>
  );
}

const NAV: [string, Key][] = [
  ["#/", "navHome"],
  ["#/new", "navNew"],
  ["#/invoices", "navInvoices"],
  ["#/approvals", "navApprovals"],
  ["#/audit", "navAudit"],
  ["#/settings", "navSettings"],
];

function OwnerApp({ hash }: { hash: string }) {
  const { t, lang, setLang } = useT();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [health, setHealth] = useState<any>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Text from the server is in the language of the request, so load it again after a switch.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) firstRun.current = false;
    else refresh();
  }, [lang, refresh]);

  useEffect(() => {
    let alive = true;
    const load = () => api("/api/health").then((data) => alive && setHealth(data)).catch(() => alive && setHealth(null));
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [version, hash]);

  const invoiceMatch = hash.match(/^#\/invoices\/(\d+)/);
  let page;
  let titleKey: Key = "navHome";
  if (invoiceMatch) {
    page = <InvoiceDetail id={Number(invoiceMatch[1])} version={version} refresh={refresh} />;
    titleKey = "navInvoices";
  } else if (hash.startsWith("#/invoices")) {
    page = <Invoices version={version} />;
    titleKey = "navInvoices";
  } else if (hash.startsWith("#/new")) {
    page = <NewInvoice key={hash} hash={hash} refresh={refresh} />;
    titleKey = "navNew";
  } else if (hash.startsWith("#/approvals")) {
    page = <Approvals version={version} refresh={refresh} />;
    titleKey = "navApprovals";
  } else if (hash.startsWith("#/audit")) {
    page = <Audit version={version} />;
    titleKey = "navAudit";
  } else if (hash.startsWith("#/settings")) {
    page = <Settings refresh={refresh} />;
    titleKey = "navSettings";
  } else {
    page = <Dashboard version={version} refresh={refresh} simulated={health?.paypal_mode === "simulated"} />;
  }

  useEffect(() => {
    document.title = `${t(titleKey)} · PaidLoop`;
  }, [titleKey, t]);

  // After moving to another page, the keyboard and screen readers start at its content.
  const pageKey = hash.split("?")[0];
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    if (!document.activeElement || document.activeElement === document.body || !mainRef.current?.contains(document.activeElement)) mainRef.current?.focus({ preventScroll: true });
  }, [pageKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      const go: Record<string, string> = { n: "#/new", i: "#/invoices", a: "#/approvals", h: "#/" };
      if (event.key === "?") {
        event.preventDefault();
        setHelpOpen(true);
      } else if (go[event.key]) {
        event.preventDefault();
        window.location.hash = go[event.key];
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isActive = (href: string) => (href === "#/" ? hash === "#/" || hash === "" : hash.startsWith(href));
  const pending = health?.pending_approvals || 0;

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(event) => (event.preventDefault(), mainRef.current?.focus())}>
        {t("skip")}
      </a>
      <header className="topbar">
        <a className="brand" href="#/">
          PaidLoop
        </a>
        <nav aria-label={t("mainNav")}>
          {NAV.map(([href, key]) => (
            <a key={href} href={href} className={isActive(href) ? "active" : ""} aria-current={isActive(href) ? "page" : undefined}>
              {t(key)}
              {key === "navApprovals" && pending > 0 ? <span className="badge">{pending}</span> : null}
            </a>
          ))}
        </nav>
        <div className="top-right">
          <StatusLights health={health} />
          <LangSwitch value={lang} onChange={setLang} />
          <AppearanceMenu />
          <button className="small help" aria-label={t("shortcutsOpen")} title={t("shortcutsOpen")} onClick={() => setHelpOpen(true)}>
            ?
          </button>
        </div>
      </header>
      {health?.sync?.last_error && (
        <div className="andon" role="alert">
          ! {t("paypalProblem")}
        </div>
      )}
      <DemoBar refresh={refresh} version={version} />
      <main className="content" id="main" tabIndex={-1} ref={mainRef}>
        {page}
      </main>
      <footer className="foot">{t("footer")}</footer>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function StatusLights({ health }: { health: any }) {
  const { t, lang, duration } = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  if (!health) return null;

  const sandbox = health.paypal_mode === "sandbox";
  const lastOk = health.sync?.last_ok_at ? new Date(health.sync.last_ok_at).getTime() : null;
  const age = lastOk ? Math.max(Math.round((now - lastOk) / 1000), 0) : null;
  const interval = health.sync?.interval_seconds || 20;
  const state = health.sync?.last_error ? "bad" : age !== null && age > interval * 3 ? "warn" : age !== null ? "good" : "idle";
  const mark = state === "bad" ? "!" : state === "warn" ? "!" : state === "good" ? "✓" : "…";
  const detail = !sandbox ? "" : age !== null ? t("paypalCheckedAgo", { time: duration(age) }) : t("paypalWaiting");

  return (
    <div className="chips" lang={lang}>
      <a className={`chip ${sandbox ? state : ""}`} title={detail} href="#/settings/connections">
        {sandbox && <span aria-hidden="true">{mark} </span>}
        {sandbox ? t("paypalSandbox") : t("paypalSimulated")}
        {detail && <span className="chip-detail"> · {detail}</span>}
      </a>
      <a className="chip" href="#/settings/connections">
        {health.ai.available ? t("aiOn", { model: health.ai.model }) : t("aiOff")}
      </a>
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const rows: [string, Key][] = [
    ["N", "shortcutNew"],
    ["I", "shortcutInvoices"],
    ["A", "shortcutApprovals"],
    ["H", "shortcutHome"],
    ["/", "shortcutSearch"],
    ["?", "shortcutHelp"],
    ["Ctrl + Enter", "shortcutSubmit"],
  ];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="shortcut-title" onClose={onClose}>
      <h2 id="shortcut-title">{t("shortcuts")}</h2>
      <table>
        <tbody>
          {rows.map(([keys, label]) => (
            <tr key={keys}>
              <td className="nowrap">
                <kbd>{keys}</kbd>
              </td>
              <td>{t(label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("shortcutsNote")}</p>
      <form method="dialog" className="button-row">
        <button className="primary">{t("close")}</button>
      </form>
    </dialog>
  );
}

function DemoBar({ refresh, version }: { refresh: () => void; version: number }) {
  const { t, day } = useT();
  const toast = useToast();
  const [clock, setClock] = useState<any>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api("/api/demo/clock").then(setClock).catch(() => undefined);
  }, [version]);

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    try {
      toast(await action());
      refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  const jump = (days: number) =>
    run(`+${days}`, async () => {
      await post("/api/demo/jump", { days });
      return t("clockMoved", { n: days });
    });

  const reset = () =>
    run("reset", async () => {
      await post("/api/demo/reset");
      window.sessionStorage.removeItem("paidloop.newInvoice");
      window.location.hash = "#/";
      return t("resetDone");
    });

  return (
    <div className="demobar">
      <span className="demo-label">{t("demo")}</span>
      <span>
        {t("clock")}: <strong>{day(clock?.today)}</strong>
        {clock?.offset_days ? ` ${t("offsetDays", { n: clock.offset_days })}` : ""}
      </span>
      <button className="small" disabled={!!busy} onClick={() => jump(7)}>
        {t("plusDays", { n: 7 })}
      </button>
      <button className="small" disabled={!!busy} onClick={() => jump(14)}>
        {t("plusDays", { n: 14 })}
      </button>
      <TwoStepButton
        className="small"
        label={busy === "reset" ? t("resetting") : t("resetDemo")}
        confirmLabel={t("resetConfirm")}
        hint={t("resetWarning")}
        disabled={!!busy}
        onConfirm={reset}
      />
    </div>
  );
}

export function RunAgentButton({ refresh, small, disabled }: { refresh: () => void; small?: boolean; disabled?: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const outcomes = await post<any[]>("/api/agent/run");
      const count = (status: string) => outcomes.filter((outcome) => outcome.status === status).length;
      const values = { checked: outcomes.length, done: count("done"), waiting: count("waiting_for_owner"), failed: count("failed") };
      toast(t(values.failed ? "agentResultFailed" : "agentResult", values), values.failed ? "error" : "good");
      refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className={`primary ${small ? "small" : ""}`} disabled={busy || disabled} aria-busy={busy} onClick={run}>
      <BusyLabel busy={busy} label={t("runAgent")} pending={t("agentWorking")} />
    </button>
  );
}
