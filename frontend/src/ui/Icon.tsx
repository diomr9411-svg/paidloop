import sprite from "../assets/icons.svg?url";
import { cx } from "./cx";
import type { IconName } from "./icon-names";

export type { IconName };
type Size = "xs" | "sm" | "md" | "lg";
export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

/**
 * One icon from the sprite file (one cached download, no code per icon). Decorative by default;
 * give it a label only when it stands alone and carries meaning.
 */
export function Icon({ name, size = "md", label, className }: { name: IconName; size?: Size; label?: string; className?: string }) {
  return (
    <svg className={cx("icon", size, className)} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} focusable="false">
      <use href={`${sprite}#${name}`} />
    </svg>
  );
}

/** A soft tinted square with an icon: the two-tone look for figures, empty states and list rows. */
export function IconTile({ name, tone = "info", size = "md" }: { name: IconName; tone?: Tone; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={cx("icon-tile", size, tone)} aria-hidden="true">
      <Icon name={name} size={size === "sm" ? "sm" : "lg"} />
    </span>
  );
}

/** Two letters for a person or company, in the same soft square. */
export function InitialsTile({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const letters =
    name
      .replace(/\b(GmbH|UG|AG|KG|Ltd|e\.K\.|OHG|GbR|mbH)\b/gi, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?";
  return (
    <span className={cx("icon-tile", "initials", size)} aria-hidden="true">
      {letters}
    </span>
  );
}
