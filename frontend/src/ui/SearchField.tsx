import { forwardRef } from "react";

import { useT } from "../i18n";
import { Button } from "./Button";
import { cx } from "./cx";
import { Icon } from "./Icon";

/** A search box with its own labelled clear button (the browser's own one is hidden). */
export const SearchField = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (value: string) => void; label: string; placeholder?: string; maxLength?: number; className?: string; id: string }
>(function SearchField({ value, onChange, label, placeholder, maxLength = 100, className, id }, ref) {
  const { t } = useT();
  return (
    <div className={cx("search-field", className)} role="search">
      <Icon name="search" className="search-icon" />
      <input
        ref={ref}
        id={id}
        type="search"
        aria-label={label}
        placeholder={placeholder || label}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <Button
          tone="ghost"
          size="sm"
          icon="x"
          iconOnly
          className="search-clear"
          onClick={() => {
            onChange("");
            if (ref && typeof ref !== "function") ref.current?.focus();
          }}
        >
          {t("clearSearch")}
        </Button>
      )}
    </div>
  );
});
