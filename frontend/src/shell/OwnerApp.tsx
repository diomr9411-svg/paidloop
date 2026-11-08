import { ComponentType, lazy, LazyExoticComponent, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import { useT } from "../i18n";
import { findRoute, ROUTES, SHAPE } from "../routes";
import { Alert } from "../ui/Alert";
import { Loading } from "../ui/Loading";
import type { Health, PageProps } from "../widgets/page";
import { useAppearance } from "./appearance";
import { DemoStrip } from "./DemoStrip";
import { ShortcutHelp } from "./ShortcutHelp";
import { TopBar } from "./TopBar";

// Each screen is its own download, fetched the first time it is opened.
const PAGES: Record<string, LazyExoticComponent<ComponentType<PageProps>>> = {
  Dashboard: lazy(() => import("../pages/Dashboard").then((m) => ({ default: m.Dashboard }))),
  NewInvoice: lazy(() => import("../pages/NewInvoice").then((m) => ({ default: m.NewInvoice }))),
  Invoices: lazy(() => import("../pages/Invoices").then((m) => ({ default: m.Invoices }))),
  InvoiceDetail: lazy(() => import("../pages/InvoiceDetail").then((m) => ({ default: m.InvoiceDetail }))),
  Approvals: lazy(() => import("../pages/Approvals").then((m) => ({ default: m.Approvals }))),
  Audit: lazy(() => import("../pages/Audit").then((m) => ({ default: m.Audit }))),
  Settings: lazy(() => import("../pages/Settings").then((m) => ({ default: m.Settings }))),
  Design: lazy(() => import("../pages/Design").then((m) => ({ default: m.Design }))),
};

/** The owner's frame: top bar, demo strip, the page, and the footer. The frame itself never waits. */
export function OwnerApp({ hash }: { hash: string }) {
  const { t, lang } = useT();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [health, setHealth] = useState<Health | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const appearance = useAppearance();
  const mainRef = useRef<HTMLElement>(null);
  const { route, param } = findRoute(hash);

  // Text from the server is in the language of the request, so load it again after a switch.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) firstRun.current = false;
    else refresh();
  }, [lang, refresh]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Health>("/api/health")
        .then((data) => alive && setHealth(data))
        .catch(() => alive && setHealth(null));
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [version, hash]);

  useEffect(() => {
    document.title = `${t(route.title)} · PaidLoop`;
  }, [route, t]);

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
      if (target.closest("input, textarea, select, [contenteditable=true], dialog")) return;
      const go = ROUTES.find((item) => item.nav?.key && item.nav.key === event.key.toLowerCase() && event.key.length === 1);
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (go) {
        event.preventDefault();
        window.location.hash = go.hash;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Page = PAGES[route.page] || PAGES.Dashboard;

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(event) => (event.preventDefault(), mainRef.current?.focus())}>
        {t("skip")}
      </a>
      <TopBar current={route} health={health} appearance={appearance} onShortcuts={() => setShortcutsOpen(true)} />
      {health?.sync?.last_error && (
        <div className="andon">
          <Alert tone="bad" role="alert" icon="plug">
            {t("paypalProblem")}
          </Alert>
        </div>
      )}
      <DemoStrip refresh={refresh} version={version} />
      <main className="content" id="main" tabIndex={-1} ref={mainRef}>
        <Suspense fallback={<Loading shape={SHAPE[route.template]} title={t(route.title)} />}>
          <Page key={route.id === "new" ? hash : route.id + param} version={version} refresh={refresh} hash={hash} param={param} health={health} />
        </Suspense>
      </main>
      <footer className="foot">{t("footer")}</footer>
      <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
