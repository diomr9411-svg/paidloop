import { ReactNode } from "react";

import { cx } from "./cx";
import { Icon, IconName, Tone } from "./Icon";

/**
 * The one small label (status, source, actor). Status colours only for status;
 * it always carries a word, and an icon when it says good, warning or problem.
 */
export function Badge({ tone = "neutral", icon, children, className }: { tone?: Tone; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={cx("badge", tone, className)}>
      {icon && <Icon name={icon} size="xs" />}
      {children}
    </span>
  );
}

/** A number on a menu link, with words for screen readers. */
export function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span className="count-badge">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A small round status mark. Never alone: a word always stands next to it. */
export function Dot({ tone }: { tone: Tone | "idle" }) {
  return <span className={cx("dot", tone)} aria-hidden="true" />;
}
