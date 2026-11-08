import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";

import { useT } from "../i18n";
import { Button } from "./Button";
import { cx } from "./cx";
import { Icon } from "./Icon";

// Toasts: short feedback, bottom right only, that a screen reader also hears.

type Tone = "good" | "error" | "info";
type Toast = { id: number; text: string; tone: Tone; leaving: boolean };

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const { t } = useT();

  const remove = useCallback((id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);
  // Leaving plays the exit first; without an animation the toast goes at once.
  const leave = useCallback(
    (id: number) => {
      const element = document.getElementById(`toast-${id}`);
      if (!element || getComputedStyle(element).animationName === "none") remove(id);
      else setToasts((all) => all.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    },
    [remove],
  );
  const show = useCallback(
    (text: string, tone: Tone = "good") => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-2), { id, text, tone, leaving: false }]);
      window.setTimeout(() => leave(id), tone === "error" ? 12000 : 6000);
    },
    [leave],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            id={`toast-${toast.id}`}
            className={cx("toast", toast.tone, toast.leaving && "closing")}
            onAnimationEnd={(event) => {
              if (toast.leaving && event.target === event.currentTarget) remove(toast.id);
            }}
          >
            <Icon name={toast.tone === "good" ? "circle-check" : toast.tone === "error" ? "circle-exclamation-point" : "info"} />
            <span>{toast.text}</span>
            <Button tone="ghost" size="sm" icon="x" iconOnly className="toast-close" onClick={() => leave(toast.id)}>
              {t("dismiss")}
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
