import { useId } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";

export type BarRow = { key: string; label: string; value: number; display: string; hint: string; risk?: boolean };

/**
 * A small bar list (dataviz method): magnitude in one hue, thin bars with a rounded end on a quiet
 * track, the value as text, and the meaning of each row on hover or keyboard focus.
 * "At risk" uses the warning colour, and always with an icon and its word, never colour alone.
 */
export function BarRows({ rows, label }: { rows: BarRow[]; label: string }) {
  const largest = Math.max(...rows.map((row) => row.value), 1);
  const id = useId();
  return (
    <ul className="bars" aria-label={label}>
      {rows.map((row) => (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- each bar can take keyboard focus so its explanation shows for keyboard users too (dataviz hover layer)
        <li className={cx("bar-row", row.risk && "risk")} key={row.key} tabIndex={0} aria-describedby={`${id}-${row.key}`}>
          <span className="bar-label">
            {row.risk && <Icon name="triangle-exclamation-point" size="sm" className="bar-risk-icon" />}
            {row.label}
          </span>
          <span className="bar-track" aria-hidden="true">
            {row.value > 0 && <span className="bar-fill" style={{ width: `${Math.max((row.value / largest) * 100, 2)}%` }} />}
          </span>
          <span className="bar-value">{row.display}</span>
          <span className="tip" role="tooltip" id={`${id}-${row.key}`}>
            {row.hint}
          </span>
        </li>
      ))}
    </ul>
  );
}
