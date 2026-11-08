import { ReactNode } from "react";

import { useT } from "../i18n";
import { Button } from "./Button";
import { cx } from "./cx";
import { Icon, IconName, Tone } from "./Icon";

const ICONS: Record<Tone, IconName> = {
  neutral: "info",
  info: "info",
  good: "circle-check",
  warn: "triangle-exclamation-point",
  bad: "circle-exclamation-point",
};

/** A message inside the page: a mark, the words, and the action that fixes it. Never colour alone. */
export function Alert({
  tone = "neutral",
  icon,
  title,
  action,
  role,
  className,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  title?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("alert", tone, className)} role={role}>
      <span className="alert-icon">
        <Icon name={icon || ICONS[tone]} />
      </span>
      <div className="alert-body">
        {title && <strong className="alert-title">{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}

/** What went wrong, and a way to try again. */
export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <Alert
      tone="bad"
      role="alert"
      action={
        onRetry && (
          <Button size="sm" icon="refresh-cw" onClick={onRetry}>
            {t("retry")}
          </Button>
        )
      }
    >
      {text}
    </Alert>
  );
}
