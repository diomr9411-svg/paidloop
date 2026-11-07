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
          aria-label={names[code]}
          title={names[code]}
          onClick={() => onChange(code)}
        >
          {code.toUpperCase()}
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

export function Loading() {
  const { t } = useT();
  return (
    <p className="muted" role="status">
      {t("loading")}
    </p>
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
