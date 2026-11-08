import { cloneElement, InputHTMLAttributes, ReactElement, ReactNode } from "react";

import { useT } from "../i18n";
import { cx } from "./cx";
import { Icon } from "./Icon";

/**
 * A form field with its label, help and problem always connected, also for screen readers.
 * `help` explains the field and shows only on focus, hover or error, so the form reads as answers.
 * `note` is a fact about the value held (always shown). `emphasis` marks a required answer that leads.
 */
export function Field({
  id,
  label,
  help,
  note,
  error,
  unsure,
  emphasis,
  labelHidden,
  className,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  note?: string;
  error?: string;
  unsure?: boolean;
  emphasis?: boolean;
  /** "md": the label is read out but hidden from 768px, where a header row names the column. */
  labelHidden?: "md";
  className?: string;
  children: ReactElement;
}) {
  const { t } = useT();
  const describedBy = [error ? `${id}-error` : "", note ? `${id}-note` : "", help ? `${id}-help` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("field", unsure && !error && "unsure", error && "invalid", emphasis && "emphasis", labelHidden === "md" && "label-md-hidden", className)}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {unsure && !error && (
        <span className="field-flag">
          <Icon name="triangle-exclamation-point" size="xs" /> {t("pleaseCheck")}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`}>
          <Icon name="circle-exclamation-point" size="xs" /> {error}
        </span>
      )}
      {note && (
        <span className="field-note" id={`${id}-note`}>
          {note}
        </span>
      )}
      {help && (
        <span className="field-help" id={`${id}-help`}>
          {help}
        </span>
      )}
    </div>
  );
}

/** The one form grid: one column on a phone, then two (or three). Every form has one gap and one breakpoint. */
export function FieldGrid({ columns = 2, className, children }: { columns?: 1 | 2 | 3; className?: string; children: ReactNode }) {
  return <div className={cx("field-grid", `cols-${columns}`, className)}>{children}</div>;
}

/** An on/off setting. A real checkbox underneath, announced as a switch. */
export function Switch({
  label,
  help,
  id,
  className,
  ...input
}: { label: ReactNode; help?: string; id: string; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <div className={cx("switch-field", className)}>
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" className="switch-input" aria-describedby={help ? `${id}-help` : undefined} {...input} />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{label}</span>
      </label>
      {help && (
        <span className="field-note switch-help" id={`${id}-help`}>
          {help}
        </span>
      )}
    </div>
  );
}

/** A plain checkbox with its label, for a yes/no that is part of a form's answer. */
export function Checkbox({ label, id, className, ...input }: { label: ReactNode; id: string; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={cx("check", className)} htmlFor={id}>
      <input id={id} type="checkbox" {...input} />
      <span>{label}</span>
    </label>
  );
}
