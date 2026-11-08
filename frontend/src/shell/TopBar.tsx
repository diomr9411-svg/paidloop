import { useEffect, useState } from "react";

import { useT } from "../i18n";
import { NAV, Route } from "../routes";
import { Badge, CountBadge, Dot } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { cx } from "../ui/cx";
import { Drawer } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { PopoverButton } from "../ui/Popover";
import { Segmented } from "../ui/Tabs";
import { LangSwitch } from "../widgets/LangSwitch";
import type { Health } from "../widgets/page";
import type { Appearance } from "./appearance";

/** The whole word is the logo, in one colour. */
function Wordmark() {
  return (
    <a className="wordmark" href="#/">
      PaidLoop
    </a>
  );
}

function NavLinks({ current, pending, onPick, vertical }: { current: Route; pending: number; onPick?: () => void; vertical?: boolean }) {
  const { t } = useT();
  return (
    <ul className={cx("nav", vertical && "vertical")}>
      {NAV.map((route) => {
        const active = current.id === route.id || current.under === route.id;
        return (
          <li key={route.id}>
            <a className="nav-link" href={route.hash} aria-current={active ? "page" : undefined} onClick={onPick}>
              <Icon name={route.nav!.icon} />
              {t(route.nav!.label)}
              {route.id === "approvals" && pending > 0 && <CountBadge count={pending} label={t("waitingCount", { n: pending })} />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** PayPal and AI at a glance; the panel says more and links to Settings > Connections. */
function StatusMenu({ health }: { health: Health | null }) {
  const { t, duration } = useT();
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
  const paypalTone = !sandbox ? "idle" : health.sync?.last_error ? "bad" : age !== null && age > interval * 3 ? "warn" : age !== null ? "good" : "idle";
  const paypalWord = !sandbox ? t("paypalSimulated") : health.sync?.last_error ? t("statusProblem") : age !== null ? t("paypalCheckedAgo", { time: duration(age) }) : t("paypalWaiting");
  const aiTone = health.ai.available ? "good" : "idle";

  return (
    <PopoverButton
      label={t("statusTitle")}
      align="end"
      wide
      buttonClassName="status-button"
      buttonContent={
        <>
          <Dot tone={paypalTone} />
          <span className="status-word">PayPal</span>
          <Dot tone={aiTone} />
          <span className="status-word">{t("aiShort")}</span>
          <span className="sr-only">{t("statusSuffix")}</span>
        </>
      }
    >
      {(close) => (
        <div className="status-panel">
          <p className="eyebrow">{t("statusTitle")}</p>
          <div className="status-row">
            <Dot tone={paypalTone} />
            <div>
              <strong>{sandbox ? t("paypalSandbox") : t("paypalSimulated")}</strong>
              <span className="muted small">{sandbox ? paypalWord : t("connectPaypalHint")}</span>
            </div>
          </div>
          <div className="status-row">
            <Dot tone={aiTone} />
            <div>
              <strong>{health.ai.available ? t("aiOn", { model: health.ai.model }) : t("aiOff")}</strong>
              <span className="muted small">{health.ai.available ? t("aiOnHint") : t("aiSourceNone")}</span>
            </div>
          </div>
          <ButtonLink size="sm" href="#/settings/connections" iconEnd="arrow-right" onClick={close}>
            {t("openConnections")}
          </ButtonLink>
        </div>
      )}
    </PopoverButton>
  );
}

function AppearanceChoices({ appearance, onShortcuts }: { appearance: Appearance; onShortcuts: () => void }) {
  const { t } = useT();
  return (
    <div className="view-choices">
      <div className="view-group">
        <p className="eyebrow">{t("theme")}</p>
        <Segmented
          label={t("theme")}
          value={appearance.theme}
          onChange={appearance.setTheme}
          options={[
            { value: "auto", label: t("themeAuto"), icon: "monitor" },
            { value: "light", label: t("themeLight"), icon: "sun" },
            { value: "dark", label: t("themeDark"), icon: "moon" },
          ]}
        />
      </div>
      <div className="view-group">
        <p className="eyebrow">{t("density")}</p>
        <Segmented
          label={t("density")}
          value={appearance.density}
          onChange={appearance.setDensity}
          options={[
            { value: "comfortable", label: t("densityComfortable") },
            { value: "compact", label: t("densityCompact") },
          ]}
        />
      </div>
      <Button tone="ghost" icon="keyboard" onClick={onShortcuts}>
        {t("shortcuts")}
      </Button>
    </div>
  );
}

export function TopBar({ current, health, appearance, onShortcuts }: { current: Route; health: Health | null; appearance: Appearance; onShortcuts: () => void }) {
  const { t, lang, setLang } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = health?.pending_approvals || 0;
  return (
    <header className="topbar">
      <div className="topbar-row">
        <Wordmark />
        <nav className="topbar-nav" aria-label={t("mainNav")}>
          <NavLinks current={current} pending={pending} />
        </nav>
        <div className="topbar-tools">
          <StatusMenu health={health} />
          <LangSwitch value={lang} onChange={setLang} className="hide-narrow" />
          <PopoverButton label={t("viewMenu")} icon="sliders-horizontal" iconOnly tone="ghost" align="end" buttonClassName="hide-narrow">
            {(close) => (
              <AppearanceChoices
                appearance={appearance}
                onShortcuts={() => {
                  close();
                  onShortcuts();
                }}
              />
            )}
          </PopoverButton>
          <Button tone="ghost" icon="menu" className="menu-button" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            {t("menu")}
            {pending > 0 && <CountBadge count={pending} label={t("waitingCount", { n: pending })} />}
          </Button>
        </div>
      </div>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} label={t("mainNav")}>
        <div className="drawer-head">
          <Wordmark />
          <Button tone="ghost" icon="x" iconOnly onClick={() => setMenuOpen(false)}>
            {t("close")}
          </Button>
        </div>
        <nav aria-label={t("mainNav")}>
          <NavLinks current={current} pending={pending} vertical onPick={() => setMenuOpen(false)} />
        </nav>
        <div className="drawer-section">
          <p className="eyebrow">{t("language")}</p>
          <LangSwitch value={lang} onChange={setLang} />
        </div>
        <div className="drawer-section">
          <AppearanceChoices
            appearance={appearance}
            onShortcuts={() => {
              setMenuOpen(false);
              onShortcuts();
            }}
          />
        </div>
        {health?.paypal_mode === "simulated" && (
          <Badge tone="warn" icon="plug">
            {t("paypalSimulated")}
          </Badge>
        )}
      </Drawer>
    </header>
  );
}
