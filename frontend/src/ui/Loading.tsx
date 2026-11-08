import { ReactNode } from "react";

import { useT } from "../i18n";
import { PageHeader } from "./PageHeader";

export { Spinner } from "./Spinner";

export type Shape = "list" | "detail" | "form" | "dashboard" | "cards" | "text";

function Lines({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={`skeleton line-${(index % 3) + 1}`} />
      ))}
    </>
  );
}

function SkeletonCard({ lines = 3, tall }: { lines?: number; tall?: boolean }) {
  return (
    <div className="skeleton-card">
      {tall && <div className="skeleton block-tall" />}
      <Lines count={lines} />
    </div>
  );
}

/** A card-sized stand-in for one panel inside a page that has already arrived. */
export function SectionSkeleton({ lines = 4 }: { lines?: number }) {
  const { t } = useT();
  return (
    <div className="loading" aria-busy="true">
      <span className="sr-only" role="status">
        {t("loading")}
      </span>
      <div className="loader-body" aria-hidden="true">
        <SkeletonCard lines={lines} tall />
      </div>
    </div>
  );
}

/**
 * Stands in for data that is not here yet. The title stays, the shaped skeleton holds its room at once
 * and is drawn only after the loader delay, so a fast answer shows nothing. A screen reader hears
 * the status straight away.
 */
export function Loading({ shape = "text", title }: { shape?: Shape; title?: string }) {
  const { t } = useT();
  return (
    <div className="loading" aria-busy="true">
      {title && <PageHeader title={title} />}
      <span className="sr-only" role="status">
        {t("loading")}
      </span>
      <div className="loader-body" aria-hidden="true">
        {shape === "list" && (
          <>
            <div className="skeleton line-3" />
            <SkeletonCard lines={6} />
          </>
        )}
        {shape === "detail" && (
          <>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={6} tall />
            <SkeletonCard lines={3} />
          </>
        )}
        {shape === "form" && (
          <>
            <SkeletonCard lines={4} tall />
            <SkeletonCard lines={4} />
          </>
        )}
        {shape === "dashboard" && (
          <>
            <div className="skeleton-grid">
              <SkeletonCard lines={2} tall />
              <SkeletonCard lines={3} tall />
            </div>
            <div className="skeleton-grid four">
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
            </div>
          </>
        )}
        {shape === "cards" && (
          <>
            <SkeletonCard lines={5} tall />
            <SkeletonCard lines={3} />
          </>
        )}
        {shape === "text" && <SkeletonCard lines={3} />}
      </div>
    </div>
  );
}

/** A re-read keeps what is on screen, dims it, and draws a thin line on the top edge. No animation of the content. */
export function Rereading({ active, children }: { active: boolean; children: ReactNode }) {
  const { t } = useT();
  return (
    <div className={active ? "rereading" : "rereading-idle"} aria-busy={active}>
      {active && <div className="progress-line" role="progressbar" aria-label={t("loading")} />}
      {children}
    </div>
  );
}
