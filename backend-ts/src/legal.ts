// German late-payment rules (Sec. 286 and 288 BGB) as plain functions. Not legal advice.
//
// - Sec. 286(1): the debtor is in default after a reminder sent after the due date.
// - Sec. 286(3): the debtor is in default at the latest 30 days after the due date and receipt of the
//   invoice. For consumers this only applies if the invoice says so.
// - Sec. 288(1) and (2): default interest is 5 points over the base rate, or 9 points if no consumer
//   is involved.
// - Sec. 288(5): in B2B cases the creditor can also claim a flat 40 EUR.
//
// A due date that the seller only prints on the invoice is not treated as a contractually agreed
// calendar date (Sec. 286(2) no. 1), so this code does not assume default from the due date alone.
import { addDays, daysBetween, IsoDate } from "./dates";
import { divideRoundHalfUp } from "./money";

// Published by the Deutsche Bundesbank, valid from 1 July 2026. It changes every 1 January and 1 July.
export const BASE_RATE_PERCENT = 1.52;
export const BASE_RATE_VALID_UNTIL: IsoDate = "2026-12-31";

const CONSUMER_POINTS = 5;
const BUSINESS_POINTS = 9;
export const B2B_FLAT_FEE_CENTS = 4000;

export interface LateCosts {
  in_default: boolean;
  default_since: IsoDate | null;
  rate_percent: number;
  days: number;
  interest_cents: number;
  flat_fee_cents: number;
  total_cents: number;
}

/** The first day the debtor is in default, or null if no rule applies. */
export function defaultStart(
  dueDate: IsoDate,
  isConsumer: boolean,
  consumerNoticeOnInvoice: boolean,
  firstReminderAfterDue: IsoDate | null,
): IsoDate | null {
  const candidates: IsoDate[] = [];
  if (firstReminderAfterDue && firstReminderAfterDue > dueDate) candidates.push(firstReminderAfterDue);
  if (!isConsumer || consumerNoticeOnInvoice) candidates.push(addDays(dueDate, 30));
  return candidates.length ? candidates.sort()[0] : null;
}

export function interestRate(isConsumer: boolean, baseRate: number = BASE_RATE_PERCENT): number {
  return Math.round((baseRate + (isConsumer ? CONSUMER_POINTS : BUSINESS_POINTS)) * 100) / 100;
}

export function lateCosts(
  openCents: number,
  today: IsoDate,
  dueDate: IsoDate,
  isConsumer: boolean,
  consumerNoticeOnInvoice: boolean,
  firstReminderAfterDue: IsoDate | null,
  baseRate: number = BASE_RATE_PERCENT,
): LateCosts {
  const since = defaultStart(dueDate, isConsumer, consumerNoticeOnInvoice, firstReminderAfterDue);
  const rate = interestRate(isConsumer, baseRate);
  if (since === null || today <= since || openCents <= 0) {
    return { in_default: false, default_since: since, rate_percent: rate, days: 0, interest_cents: 0, flat_fee_cents: 0, total_cents: 0 };
  }
  const days = daysBetween(today, since);
  // open x rate% x days / 365, with the rate in hundredths of a percent so no float error creeps in
  const interest = divideRoundHalfUp(openCents * Math.round(rate * 100) * days, 100 * 100 * 365);
  const flat = isConsumer ? 0 : B2B_FLAT_FEE_CENTS;
  return { in_default: true, default_since: since, rate_percent: rate, days, interest_cents: interest, flat_fee_cents: flat, total_cents: interest + flat };
}
