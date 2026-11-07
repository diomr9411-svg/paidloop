// Invoice states and the changes that are allowed between them.

export const DRAFT = "draft";
export const CHECKED = "checked";
export const ISSUED = "issued";
export const ON_PLAN = "on_plan";
export const DISPUTED = "disputed";
export const PAID = "paid";
export const CANCELLED = "cancelled";

export const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  [DRAFT]: new Set([CHECKED]),
  [CHECKED]: new Set([DRAFT, ISSUED]),
  [ISSUED]: new Set([ON_PLAN, DISPUTED, PAID, CANCELLED]),
  [ON_PLAN]: new Set([DISPUTED, PAID, CANCELLED]),
  [DISPUTED]: new Set([ISSUED, ON_PLAN, PAID, CANCELLED]),
  [PAID]: new Set(),
  [CANCELLED]: new Set(),
};
export const OPEN_STATES: readonly string[] = [ISSUED, ON_PLAN, DISPUTED];

export class InvalidTransition extends Error {}

/** Returns the new state, or throws if the change is not allowed. Staying in the same state is fine. */
export function moveTo(current: string, target: string): string {
  if (target === current) return current;
  if (!ALLOWED_TRANSITIONS[current]?.has(target)) throw new InvalidTransition(`An invoice cannot go from ${current} to ${target}`);
  return target;
}
