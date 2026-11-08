import { Lang, useT } from "../i18n";
import { Segmented } from "../ui/Tabs";

/** German or English. Each choice names its language in its own language for screen readers. */
export function LangSwitch({ value, onChange, className }: { value: Lang; onChange: (lang: Lang) => void; className?: string }) {
  const { t } = useT();
  return (
    <Segmented
      label={t("language")}
      className={className}
      value={value}
      onChange={onChange}
      options={[
        { value: "de", label: "DE", lang: "de", name: "Deutsch" },
        { value: "en", label: "EN", lang: "en", name: "English" },
      ]}
    />
  );
}
