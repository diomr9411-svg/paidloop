import { useEffect, useState } from "react";

import { api, post } from "../api";
import { useT } from "../i18n";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmButton } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/Toast";

/** Demo controls: the clock can jump ahead so reminders become due, and everything can start fresh. */
export function DemoStrip({ refresh, version }: { refresh: () => void; version: number }) {
  const { t, day } = useT();
  const toast = useToast();
  const [clock, setClock] = useState<{ today: string; offset_days: number } | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api("/api/demo/clock").then(setClock).catch(() => undefined);
  }, [version]);

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    try {
      toast(await action());
      refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  const jump = (days: number) =>
    run(`+${days}`, async () => {
      await post("/api/demo/jump", { days });
      return t("clockMoved", { n: days });
    });

  return (
    <div className="demo-strip" role="region" aria-label={t("demoControls")}>
      <Badge tone="info">{t("demo")}</Badge>
      <span className="demo-clock">
        <Icon name="clock" size="sm" />
        {t("clock")}: <strong>{day(clock?.today)}</strong>
        {clock?.offset_days ? <span className="muted"> {t("offsetDays", { n: clock.offset_days })}</span> : null}
      </span>
      <div className="demo-actions">
        <Button size="sm" busy={busy === "+7"} disabled={!!busy} onClick={() => jump(7)}>
          {t("plusDays", { n: 7 })}
        </Button>
        <Button size="sm" busy={busy === "+14"} disabled={!!busy} onClick={() => jump(14)}>
          {t("plusDays", { n: 14 })}
        </Button>
        <ConfirmButton
          size="sm"
          tone="ghost"
          icon="refresh-cw"
          label={t("resetDemo")}
          title={t("resetTitle")}
          body={t("resetWarning")}
          confirmLabel={t("resetConfirm")}
          disabled={!!busy}
          onConfirm={() =>
            run("reset", async () => {
              await post("/api/demo/reset");
              window.sessionStorage.removeItem("paidloop.newInvoice");
              window.location.hash = "#/";
              return t("resetDone");
            })
          }
        />
      </div>
    </div>
  );
}
