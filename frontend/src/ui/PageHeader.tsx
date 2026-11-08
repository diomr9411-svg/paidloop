import { ReactNode } from "react";

import { useT } from "../i18n";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { PopoverButton } from "./Popover";

export type Template = "dashboard" | "list" | "detail" | "wizard" | "settings" | "customer" | "catalogue";

/**
 * A screen picks its template; the template decides the width and the rhythm, not the screen.
 * Every template uses the same page header.
 */
export function Page({ template, children }: { template: Template; children: ReactNode }) {
  return (
    <div className={cx("page", `page-${template}`)} data-template={template}>
      {children}
    </div>
  );
}

/** The one page header: the page's only h1, its actions on the same row, a back link above, help behind an (i). */
export function PageHeader({ title, back, info, meta, actions }: { title: string; back?: { href: string; label: string }; info?: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      {back && (
        <a className="page-back" href={back.href}>
          <Icon name="arrow-left" size="sm" />
          {back.label}
        </a>
      )}
      <div className="page-title-row">
        <div className="page-title">
          <h1>{title}</h1>
          {meta}
          {info && <InfoButton text={info} />}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** Help for a whole page, behind a small (i) button rather than a paragraph under the title. */
export function InfoButton({ text }: { text: string }) {
  const { t } = useT();
  return (
    <PopoverButton label={t("aboutPage")} icon="info" iconOnly tone="ghost" size="sm" buttonClassName="info-button">
      <p className="popover-text">{text}</p>
    </PopoverButton>
  );
}
