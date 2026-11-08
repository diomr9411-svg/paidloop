import { useT } from "../i18n";
import { Badge } from "../ui/Badge";
import type { IconName, Tone } from "../ui/Icon";

/** An invoice's state as a badge with a word and an icon. Late open invoices say how late. */
export function StatusBadge({ status, overdue }: { status: string; overdue?: number }) {
  const { labels, daysLate } = useT();
  const late = !!overdue && overdue > 0 && (status === "issued" || status === "on_plan");
  let tone: Tone = "info";
  let icon: IconName = "clock";
  if (status === "paid") [tone, icon] = ["good", "circle-check"];
  else if (late) [tone, icon] = ["warn", "triangle-exclamation-point"];
  else if (status === "disputed") [tone, icon] = ["warn", "circle-pause"];
  else if (status === "on_plan") [tone, icon] = ["info", "calendar-clock"];
  else if (status === "cancelled") [tone, icon] = ["neutral", "ban"];
  else if (status === "draft" || status === "checked") [tone, icon] = ["neutral", "file-pen"];
  return (
    <Badge tone={tone} icon={icon}>
      {late ? daysLate(overdue!) : labels.status[status] || status}
    </Badge>
  );
}
