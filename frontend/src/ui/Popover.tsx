import { ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button, ButtonTone } from "./Button";
import { cx } from "./cx";
import { useExit } from "./exit";
import { IconName } from "./Icon";

/**
 * A button that opens a small panel next to it (help, status, view settings). It closes on Escape,
 * on a click outside, or when its button is pressed again, and gives focus back to its button.
 */
export function PopoverButton({
  label,
  icon,
  iconOnly,
  tone = "secondary",
  size = "md",
  align = "start",
  wide,
  panelLabel,
  buttonContent,
  buttonClassName,
  children,
}: {
  label: string;
  icon?: IconName;
  iconOnly?: boolean;
  tone?: ButtonTone;
  size?: "sm" | "md";
  align?: "start" | "end";
  wide?: boolean;
  panelLabel?: string;
  /** Custom content inside the button; its words are the button's name, so they must say what it opens. */
  buttonContent?: ReactNode;
  buttonClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const exit = useExit<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="popover-wrap" ref={wrap}>
      {buttonContent ? (
        <button ref={button} type="button" className={cx("btn", tone, size, buttonClassName)} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          {buttonContent}
        </button>
      ) : (
        <Button ref={button} tone={tone} size={size} icon={icon} iconOnly={iconOnly} className={buttonClassName} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          {label}
        </Button>
      )}
      {exit.shown && (
        <div
          ref={exit.ref}
          id={panelId}
          className={cx("popover", align, wide && "wide", exit.closing && "closing")}
          role="group"
          aria-label={panelLabel || label}
          onAnimationEnd={exit.onAnimationEnd}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
