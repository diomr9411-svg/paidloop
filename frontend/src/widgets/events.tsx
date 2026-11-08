import { Tools, useT } from "../i18n";
import { Badge } from "../ui/Badge";
import type { IconName } from "../ui/Icon";

const HIDDEN = new Set(["paypal_ids", "paypal_id", "paypal_payment_id", "reason_de", "issues", "error_count"]);

/** Turns the stored details of a step into a short readable line in the chosen language. */
export function eventText(data: Record<string, unknown>, tools: Tools): string {
  const { t, lang, labels, eur } = tools;
  return Object.entries(data)
    .filter(([key, value]) => !HIDDEN.has(key) && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => {
      const name = key.endsWith("_cents") ? key.replace("_cents", "") : key;
      const label = labels.field[name] || name.replaceAll("_", " ");
      let shown: unknown = value;
      if (key.endsWith("_cents") && typeof value === "number") shown = eur(value);
      else if (key === "reason" && lang === "de" && data.reason_de) shown = data.reason_de;
      else if (key === "action" || key === "proposed") shown = labels.action[String(value)] || value;
      else if (typeof value === "boolean") shown = value ? t("yes") : t("no");
      else if (Array.isArray(value)) shown = value.join(", ");
      else if (typeof value === "string" && labels.value[value]) shown = labels.value[value];
      return `${label}: ${shown}`;
    })
    .join(" · ");
}

const ACTOR_ICONS: Record<string, IconName> = {
  owner: "user",
  ai: "sparkles",
  rules: "list-checks",
  customer: "message-square",
  paypal: "credit-card",
  system: "cog",
  demo: "play",
};

/** Who did a step. Told by an icon and a word; status colours are not used for people. */
export function ActorBadge({ actor }: { actor: string }) {
  const { labels } = useT();
  return (
    <Badge tone={actor === "owner" ? "info" : "neutral"} icon={ACTOR_ICONS[actor] || "cog"}>
      {labels.actor[actor] || actor}
    </Badge>
  );
}
