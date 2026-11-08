import { cx } from "./cx";
import { Icon } from "./Icon";

/** The steps of one job, joined by a line. Finished steps carry a check, the current one is filled. */
export function Stepper({ steps, current, label }: { steps: string[]; current: number; label: string }) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((name, index) => {
        const state = index < current ? "complete" : index === current ? "current" : "todo";
        return (
          <li key={name} className={cx("step", state)} aria-current={index === current ? "step" : undefined}>
            <span className="step-mark" aria-hidden="true">
              {state === "complete" ? <Icon name="check" size="xs" /> : index + 1}
            </span>
            <span className="step-label">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}
