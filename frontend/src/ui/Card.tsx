import { ReactNode, useId } from "react";

import { cx } from "./cx";
import { IconName, IconTile, Tone } from "./Icon";

/**
 * A card with a title row (title, a short line under it, actions on the right), its content, and an
 * optional footer for the card's own Save. Cards are equals; the title is what leads.
 */
export function SectionCard({
  title,
  subtitle,
  icon,
  iconTone,
  actions,
  footer,
  tone,
  flush,
  id,
  className,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  iconTone?: Tone;
  actions?: ReactNode;
  footer?: ReactNode;
  tone?: "attention" | "brand";
  /** For a table that runs edge to edge: the head and foot keep their room, the body does not. */
  flush?: boolean;
  id?: string;
  className?: string;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={cx("card", tone, flush && "flush", className)} id={id} aria-labelledby={titleId}>
      <div className="card-head">
        <div className="card-title">
          {icon && <IconTile name={icon} tone={iconTone} size="sm" />}
          <div className="card-title-text">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {children}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

/** A plain card for content that has no title of its own (a callout, an empty state). */
export function Card({ tone, className, children }: { tone?: "attention" | "brand"; className?: string; children: ReactNode }) {
  return <div className={cx("card", tone, className)}>{children}</div>;
}
