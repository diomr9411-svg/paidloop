import { ReactElement, cloneElement, useId } from "react";

/**
 * A short explanation that appears on hover and on keyboard focus, drawn by the app (never the
 * browser's own tooltip). The text is also the element's description for screen readers.
 */
export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  const id = useId();
  return (
    <span className="tip-wrap">
      {cloneElement(children, { "aria-describedby": id })}
      <span className="tip" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}
