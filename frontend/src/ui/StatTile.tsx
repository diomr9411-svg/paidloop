import { ReactNode } from "react";

import { cx } from "./cx";
import { Icon, IconName, IconTile, Tone } from "./Icon";

/**
 * One figure with its label and a short note. Shows its real value on the first frame (no count-up).
 * A tile with a link opens the list behind the figure.
 */
export function StatTile({ label, value, note, icon, tone = "info", href }: { label: string; value: string; note?: ReactNode; icon: IconName; tone?: Tone; href?: string }) {
  const inner = (
    <>
      <span className="stat-label">{label}</span>
      <IconTile name={icon} tone={tone} />
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
      {href && <Icon name="arrow-right" size="sm" className="stat-go" />}
    </>
  );
  const className = cx("card", "stat", tone === "warn" && "warn", tone === "bad" && "bad");
  return href ? (
    <a className={cx(className, "stat-link")} href={href}>
      {inner}
    </a>
  ) : (
    <div className={className}>{inner}</div>
  );
}
