import { ReactNode } from "react";

import { IconName, IconTile, Tone } from "./Icon";

/** Nothing to show yet: say so, say why, and offer the next action. */
export function EmptyState({
  icon,
  tone = "info",
  title,
  hint,
  action,
  heading,
  titleId,
}: {
  icon: IconName;
  tone?: Tone;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** When the empty state is the whole card, its title is the card's heading. */
  heading?: boolean;
  titleId?: string;
}) {
  return (
    <div className="empty">
      <IconTile name={icon} tone={tone} size="lg" />
      {heading ? (
        <h2 className="empty-title" id={titleId}>
          {title}
        </h2>
      ) : (
        <p className="empty-title">{title}</p>
      )}
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
