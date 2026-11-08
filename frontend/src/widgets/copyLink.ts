import { useT } from "../i18n";
import { useToast } from "../ui/Toast";

/** Copies the customer link and says what happened. */
export function useCopyLink() {
  const toast = useToast();
  const { t } = useT();
  return async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast(t("linkCopied"));
    } catch {
      toast(t("copyFailed", { link }), "error");
    }
  };
}
