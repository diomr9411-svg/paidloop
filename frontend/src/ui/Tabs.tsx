import { ReactNode } from "react";

import { cx } from "./cx";
import { Icon, IconName } from "./Icon";

export type FilterOption = { value: string; label: string; count?: number };

/**
 * A row of filters with counts (from 768px), or one choice box on a phone, so the toolbar
 * never wraps into many rows. The filter lives in the address, so the back button restores it.
 */
export function FilterTabs({ label, options, value, onChange }: { label: string; options: FilterOption[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="filter-tabs">
      <div className="tabs" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" className="tab" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
            {option.label}
            {option.count !== undefined && <span className="tab-count">{option.count}</span>}
          </button>
        ))}
      </div>
      <label className="tabs-select">
        <span className="sr-only">{label}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.count !== undefined ? ` (${option.count})` : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** A small set of choices where exactly one is on (language, theme, spacing). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  /** `name` is read out after the visible label (e.g. "DE Deutsch"), so the visible words stay part of the name. */
  options: { value: T; label: ReactNode; icon?: IconName; lang?: string; name?: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("segmented", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment"
          lang={option.lang}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <Icon name={option.icon} size="sm" />}
          {option.label}
          {option.name && <span className="sr-only"> {option.name}</span>}
        </button>
      ))}
    </div>
  );
}
