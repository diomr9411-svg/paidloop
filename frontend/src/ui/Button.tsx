import { AnchorHTMLAttributes, ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, IconName } from "./Icon";
import { Spinner } from "./Spinner";

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md" | "lg";

interface Look {
  tone?: ButtonTone;
  size?: Size;
  icon?: IconName;
  iconEnd?: IconName;
  full?: boolean;
  /** Only an icon is shown; the label is still read out and shown as a tooltip-free accessible name. */
  iconOnly?: boolean;
}

/**
 * The one button. While busy it is disabled at once, the spinner takes the icon's place
 * and the label says what is happening ("Saving...").
 */
export const Button = forwardRef<
  HTMLButtonElement,
  Look & ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; pending?: string; children: ReactNode }
>(function Button({ tone = "secondary", size = "md", icon, iconEnd, full, iconOnly, busy, pending, className, disabled, type = "button", children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", tone, size, full && "full", iconOnly && "icon-only", className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={iconOnly && typeof children === "string" ? children : rest["aria-label"]}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={size === "sm" ? "sm" : "md"} /> : null}
      {iconOnly ? null : busy && pending ? pending : children}
      {iconEnd && !busy && <Icon name={iconEnd} size={size === "sm" ? "sm" : "md"} />}
    </button>
  );
});

/** A link that looks like a button, for moving to a page or a file. Opens in a new tab only when asked. */
export function ButtonLink({
  tone = "secondary",
  size = "md",
  icon,
  iconEnd,
  full,
  iconOnly,
  external,
  className,
  children,
  ...rest
}: Look & AnchorHTMLAttributes<HTMLAnchorElement> & { external?: boolean; children: ReactNode }) {
  return (
    <a
      className={cx("btn", tone, size, full && "full", iconOnly && "icon-only", className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      aria-label={iconOnly && typeof children === "string" ? children : rest["aria-label"]}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? "sm" : "md"} />}
      {iconOnly ? null : children}
      {(iconEnd || external) && <Icon name={iconEnd || "external-link"} size="sm" />}
    </a>
  );
}

/** Button content while it works, for buttons that are not the Button part (rare). */
export function BusyLabel({ busy, label, pending }: { busy: boolean; label: string; pending?: string }) {
  return (
    <>
      {busy && <Spinner />}
      {busy && pending ? pending : label}
    </>
  );
}
