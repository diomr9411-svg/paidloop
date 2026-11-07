import { cloneElement, createContext, ReactElement, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { Lang, useT } from "./i18n";

// Toasts: short feedback that a screen reader also hears.

type Tone = "good" | "error" | "info";
type Toast = { id: number; text: string; tone: Tone };

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const { t } = useT();

  const remove = useCallback((id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (text: string, tone: Tone = "good") => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-2), { id, text, tone }]);
      window.setTimeout(() => remove(id), tone === "error" ? 12000 : 6000);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <span>
              {toast.tone === "good" ? "✓ " : toast.tone === "error" ? "! " : ""}
              {toast.text}
            </span>
            <button className="link" aria-label={t("dismiss")} onClick={() => remove(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// A form field with its label, hint and problem always connected, also for screen readers.

export function Field({
  id,
  label,
  hint,
  error,
  unsure,
  className = "",
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  unsure?: boolean;
  className?: string;
  children: ReactElement;
}) {
  const { t } = useT();
  const describedBy = [error ? `${id}-error` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${unsure && !error ? "unsure" : ""} ${error ? "invalid" : ""} ${className}`}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {unsure && !error && <span className="field-flag">! {t("pleaseCheck")}</span>}
      {error && (
        <span className="field-error" id={`${id}-error`}>
          ! {error}
        </span>
      )}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function StatusPill({ status, overdue }: { status: string; overdue?: number }) {
  const { labels, daysLate } = useT();
  const late = !!overdue && overdue > 0 && (status === "issued" || status === "on_plan");
  const tone = status === "paid" ? "good" : status === "disputed" || late ? "warn" : status === "cancelled" || status === "draft" || status === "checked" ? "" : "info";
  const text = late ? daysLate(overdue!) : labels.status[status] || status;
  return (
    <span className={`pill ${tone}`}>
      {tone === "good" ? "✓ " : tone === "warn" ? "! " : ""}
      {text}
    </span>
  );
}

export function LangSwitch({ value, onChange }: { value: Lang; onChange: (lang: Lang) => void }) {
  const { t } = useT();
  const names: Record<Lang, string> = { de: "Deutsch", en: "English" };
  return (
    <div className="lang-switch" role="group" aria-label={t("language")}>
      {(["de", "en"] as const).map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className={`small ${value === code ? "selected" : ""}`}
          aria-pressed={value === code}
          title={names[code]}
          onClick={() => onChange(code)}
        >
          {code.toUpperCase()}
          <span className="sr-only"> {names[code]}</span>
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** Button content while it works: the spinner replaces the leading icon and the label says what is happening. */
export function BusyLabel({ busy, label, pending }: { busy: boolean; label: string; pending?: string }) {
  return (
    <>
      {busy && <Spinner />}
      {busy && pending ? pending : label}
    </>
  );
}

function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={`skeleton line-${(index % 3) + 1}`} />
      ))}
    </>
  );
}

function SkeletonCard({ lines = 3, tall }: { lines?: number; tall?: boolean }) {
  return (
    <div className="skeleton-card">
      {tall && <div className="skeleton block-tall" />}
      <SkeletonLines count={lines} />
    </div>
  );
}

export type Shape = "list" | "detail" | "form" | "dashboard" | "cards" | "text";

/**
 * Stands in for data that is not here yet. The title stays, the shaped skeleton holds its room at once
 * and is drawn only after the loader delay, so a fast answer shows nothing. A screen reader hears
 * the status straight away.
 */
export function Loading({ shape = "text", title }: { shape?: Shape; title?: string }) {
  const { t } = useT();
  return (
    <div className="loading" aria-busy="true">
      {title && <PageHeader title={title} />}
      <span className="sr-only" role="status">
        {t("loading")}
      </span>
      <div className="loader-body" aria-hidden="true">
        {shape === "list" && (
          <>
            <div className="skeleton line-3" />
            <SkeletonCard lines={6} />
          </>
        )}
        {shape === "detail" && (
          <>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={6} />
            <SkeletonCard lines={3} />
          </>
        )}
        {shape === "form" && (
          <>
            <SkeletonCard lines={4} />
            <SkeletonCard lines={4} />
          </>
        )}
        {shape === "dashboard" && (
          <>
            <div className="skeleton-grid">
              <SkeletonCard lines={2} tall />
              <SkeletonCard lines={2} tall />
            </div>
            <div className="skeleton-grid">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          </>
        )}
        {shape === "cards" && (
          <>
            <SkeletonCard lines={5} tall />
            <SkeletonCard lines={3} />
          </>
        )}
        {shape === "text" && <SkeletonCard lines={3} />}
      </div>
    </div>
  );
}

/** A re-read keeps what is on screen, dims it, and draws a thin line on the top edge. No animation of the content. */
export function Rereading({ active, children }: { active: boolean; children: ReactNode }) {
  const { t } = useT();
  return (
    <div className={active ? "rereading" : undefined} aria-busy={active}>
      {active && <div className="progress-line" role="progressbar" aria-label={t("loading")} />}
      {children}
    </div>
  );
}

/** The one page header: the page's only h1, its actions on the same row, a back link above, help behind an (i). */
export function PageHeader({
  title,
  back,
  info,
  actions,
}: {
  title: string;
  back?: { href: string; label: string };
  info?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <a className="page-back" href={back.href}>
          ← {back.label}
        </a>
      )}
      <div className="page-title-row">
        <div className="page-title">
          <h1>{title}</h1>
          {info && <InfoButton text={info} />}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** Closes on Escape or a click outside, and gives focus back to its button. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);
  return { open, setOpen, wrap, button };
}

export function InfoButton({ text }: { text: string }) {
  const { t } = useT();
  const { open, setOpen, wrap, button } = usePopover();
  return (
    <div className="info-wrap" ref={wrap}>
      <button ref={button} className="info-button" aria-label={t("aboutPage")} aria-expanded={open} aria-controls="page-info" onClick={() => setOpen(!open)}>
        i
      </button>
      {open && (
        <div className="popover" id="page-info" role="region" aria-label={t("aboutPage")}>
          {text}
        </div>
      )}
    </div>
  );
}

/** Theme and density are each person's choice, kept on this computer and applied before the first paint. */
export function AppearanceMenu() {
  const { t } = useT();
  const { open, setOpen, wrap, button } = usePopover();
  const [theme, setTheme] = useState(() => window.localStorage.getItem("paidloop.theme") || "auto");
  const [density, setDensity] = useState(() => (window.localStorage.getItem("paidloop.density") === "compact" ? "compact" : "comfortable"));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", theme === "dark" || (theme === "auto" && media.matches) ? "dark" : "light");
    apply();
    window.localStorage.setItem("paidloop.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    window.localStorage.setItem("paidloop.density", density);
  }, [density]);

  const choice = (value: string, current: string, set: (value: string) => void, label: string) => (
    <button type="button" className={`small ${current === value ? "selected" : ""}`} aria-pressed={current === value} onClick={() => set(value)}>
      {label}
    </button>
  );

  return (
    <div className="menu" ref={wrap}>
      <button ref={button} className="small" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("appearance")}
      </button>
      {open && (
        <div className="menu-panel" role="group" aria-label={t("appearance")}>
          <div>
            <div className="menu-label">{t("theme")}</div>
            <div className="segmented">
              {choice("auto", theme, setTheme, t("themeAuto"))}
              {choice("light", theme, setTheme, t("themeLight"))}
              {choice("dark", theme, setTheme, t("themeDark"))}
            </div>
          </div>
          <div>
            <div className="menu-label">{t("density")}</div>
            <div className="segmented">
              {choice("comfortable", density, setDensity, t("densityComfortable"))}
              {choice("compact", density, setDensity, t("densityCompact"))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="alert error" role="alert">
      ! {text}
      {onRetry && (
        <button className="small retry" onClick={onRetry}>
          {t("retry")}
        </button>
      )}
    </div>
  );
}

/** A dangerous step needs a second, clearly worded click. It falls back by itself after a few seconds. */
export function TwoStepButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  hint,
  className = "danger",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  hint?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <>
      <button
        className={className}
        disabled={disabled}
        onClick={() => {
          if (armed) {
            setArmed(false);
            onConfirm();
          } else {
            setArmed(true);
          }
        }}
      >
        {armed ? confirmLabel : label}
      </button>
      {armed && hint && (
        <p className="muted small" role="status">
          {hint}
        </p>
      )}
    </>
  );
}

/** Copies the customer link and says what happened. */
export function useCopyLink() {
  const toast = useToast();
  const { t } = useT();
  return async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast(t("linkCopied"));
    } catch {
      toast(t("copyFailed", { link }), "error");
    }
  };
}

export function BarRows({ rows, label }: { rows: { key: string; label: string; cents: number; risk?: boolean; hint: string }[]; label: string }) {
  const { eur } = useT();
  const largest = Math.max(...rows.map((row) => row.cents), 1);
  return (
    <div className="bars" role="list" aria-label={label}>
      {rows.map((row) => (
        <div className="bar-row" key={row.key} role="listitem" title={`${row.label}: ${eur(row.cents)}. ${row.hint}`}>
          <div className="bar-label">
            {row.risk && (
              <span className="risk-icon" aria-hidden="true">
                !
              </span>
            )}
            {row.label}
          </div>
          <div className="bar-track">
            {row.cents > 0 && <div className={`bar-fill ${row.risk ? "risk" : ""}`} style={{ width: `${Math.max((row.cents / largest) * 100, 1.5)}%` }} />}
          </div>
          <div className="bar-value">{eur(row.cents)}</div>
        </div>
      ))}
    </div>
  );
}
