import { ReactNode } from "react";

import { cx } from "./cx";

/**
 * A main column and a side column on wide screens (from 1280px, or 1024px for "even"), one column on
 * smaller screens, main first. Without side content the main column takes the whole width.
 * Screens use this instead of laying themselves out.
 */
export function Split({ main, side, even }: { main: ReactNode; side?: ReactNode; even?: boolean }) {
  if (!side) return <div className="split-main">{main}</div>;
  return (
    <div className={cx("split", even && "even")}>
      <div className="split-main">{main}</div>
      <div className="split-side">{side}</div>
    </div>
  );
}

/** Cards two by two on wide screens. Cards in one row share a height, so their own Save buttons line up. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="card-grid">{children}</div>;
}
