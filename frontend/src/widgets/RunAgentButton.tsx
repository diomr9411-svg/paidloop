import { useState } from "react";

import { post } from "../api";
import { useT } from "../i18n";
import { Button, ButtonTone } from "../ui/Button";
import { useToast } from "../ui/Toast";

/** Runs the follow-up agent once over every open invoice and says what it did. */
export function RunAgentButton({ refresh, tone = "secondary", size = "md", disabled }: { refresh: () => void; tone?: ButtonTone; size?: "sm" | "md"; disabled?: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const outcomes = await post<{ status: string }[]>("/api/agent/run");
      const count = (status: string) => outcomes.filter((outcome) => outcome.status === status).length;
      const values = { checked: outcomes.length, done: count("done"), waiting: count("waiting_for_owner"), failed: count("failed") };
      toast(t(values.failed ? "agentResultFailed" : "agentResult", values), values.failed ? "error" : "good");
      refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button tone={tone} size={size} icon="sparkles" busy={busy} pending={t("agentWorking")} disabled={disabled} onClick={run}>
      {t("runAgent")}
    </Button>
  );
}
