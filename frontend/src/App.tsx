import { useCallback, useEffect, useState } from "react";

import { api, day, post } from "./api";
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
  if (payMatch) return <PayPage token={payMatch[1]} />;
  return <OwnerApp hash={hash} />;
}

function OwnerApp({ hash }: { hash: string }) {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [health, setHealth] = useState<any>(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api("/api/health").then(setHealth).catch(() => setHealth(null));
    api<any[]>("/api/approvals").then((rows) => setPending(rows.length)).catch(() => undefined);
  }, [version, hash]);

  const invoiceMatch = hash.match(/^#\/invoices\/(\d+)/);
  let page;
  if (invoiceMatch) page = <InvoiceDetail id={Number(invoiceMatch[1])} version={version} refresh={refresh} />;
  else if (hash.startsWith("#/invoices")) page = <Invoices version={version} />;
  else if (hash.startsWith("#/new")) page = <NewInvoice refresh={refresh} />;
  else if (hash.startsWith("#/approvals")) page = <Approvals version={version} refresh={refresh} />;
  else if (hash.startsWith("#/audit")) page = <Audit version={version} />;
  else if (hash.startsWith("#/settings")) page = <Settings refresh={refresh} />;
  else page = <Dashboard version={version} />;

  const nav: [string, string, number?][] = [
    ["#/", "Home"],
    ["#/new", "New invoice"],
    ["#/invoices", "Invoices"],
    ["#/approvals", "Approvals", pending],
    ["#/audit", "Audit trail"],
    ["#/settings", "Settings"],
  ];
  const isActive = (href: string) => (href === "#/" ? hash === "#/" || hash === "" : hash.startsWith(href));

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          PaidLoop
        </a>
        <nav>
          {nav.map(([href, label, count]) => (
            <a key={href} href={href} className={isActive(href) ? "active" : ""}>
              {label}
              {count ? <span className="badge">{count}</span> : null}
            </a>
          ))}
        </nav>
        <div className="chips">
          {health && (
            <>
              <span className="chip">{health.paypal_mode === "sandbox" ? "PayPal sandbox" : "PayPal simulated"}</span>
              <span className="chip">{health.ai.available ? `Local AI: ${health.ai.model}` : "AI off: fixed rules"}</span>
            </>
          )}
        </div>
      </header>
      <DemoBar refresh={refresh} version={version} />
      <main className="content">{page}</main>
      <footer className="foot">Test money only. Made-up demo data. Not tax or legal advice.</footer>
    </div>
  );
}

function DemoBar({ refresh, version }: { refresh: () => void; version: number }) {
  const [clock, setClock] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    api("/api/demo/clock").then(setClock).catch(() => undefined);
  }, [version]);

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setNote("");
    try {
      setNote(await action());
      refresh();
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  const jump = (days: number) =>
    run(`+${days}`, async () => {
      await post("/api/demo/jump", { days });
      return `The demo clock moved ${days} days.`;
    });

  const agent = () =>
    run("agent", async () => {
      const outcomes = await post<any[]>("/api/agent/run");
      const done = outcomes.filter((o) => o.status === "done").length;
      const waiting = outcomes.filter((o) => o.status === "waiting_for_owner").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      return `Agent checked ${outcomes.length} invoices: ${done} sent, ${waiting} waiting for you${failed ? `, ${failed} failed` : ""}.`;
    });

  const reset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setNote("This deletes everything in the app and creates fresh demo data. Click again to confirm.");
      return;
    }
    setConfirmReset(false);
    run("reset", async () => {
      await post("/api/demo/reset");
      window.location.hash = "#/";
      return "Fresh demo data is ready.";
    });
  };

  return (
    <div className="demobar">
      <span className="demo-label">Demo</span>
      <span>
        Clock: <strong>{day(clock?.today)}</strong>
        {clock?.offset_days ? ` (+${clock.offset_days} days)` : ""}
      </span>
      <button className="small" disabled={!!busy} onClick={() => jump(7)}>
        +7 days
      </button>
      <button className="small" disabled={!!busy} onClick={() => jump(14)}>
        +14 days
      </button>
      <button className="small primary" disabled={!!busy} onClick={agent}>
        {busy === "agent" ? "Agent is working..." : "Run follow-up agent"}
      </button>
      <button className="small" disabled={!!busy} onClick={reset}>
        {busy === "reset" ? "Creating demo data..." : confirmReset ? "Yes, reset" : "Reset demo"}
      </button>
      {note && <span className="demo-note">{note}</span>}
    </div>
  );
}
