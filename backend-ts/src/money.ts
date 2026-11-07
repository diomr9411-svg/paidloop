// Money helpers. Amounts are whole cents (integers) everywhere, so rounding errors cannot build up.

/** Integer division that rounds half away from zero, like Decimal ROUND_HALF_UP. */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** Euros as text or number to cents, rounding half up as invoices normally do. */
export function toCents(value: string | number): number {
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`Not an amount: ${text}`);
  const sign = match[1] ? -1 : 1;
  const whole = Number(match[2] || "0");
  const fraction = (match[3] || "").padEnd(3, "0");
  const cents = whole * 100 + Number(fraction.slice(0, 2));
  const roundUp = Number(fraction[2]) >= 5 ? 1 : 0;
  // Longer fractions only matter through the third digit for half-up rounding
  return sign * (cents + roundUp);
}

/** 19% is 1900 basis points. */
export function percentOf(cents: number, basisPoints: number): number {
  return divideRoundHalfUp(cents * basisPoints, 10000);
}

/** Net line total. Quantity is in thousandths, so 1.5 hours is 1500. */
export function lineNet(quantityMilli: number, unitPriceCents: number): number {
  return divideRoundHalfUp(quantityMilli * unitPriceCents, 1000);
}

function grouped(cents: number, thousands: string, decimal: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return `${sign}${whole}${decimal}${String(abs % 100).padStart(2, "0")}`;
}

/** English format for messages and PDFs: 1,234.50 EUR. */
export function eur(cents: number): string {
  return `${grouped(cents, ",", ".")} EUR`;
}

/** German format: 1.234,50 EUR. */
export function eurDe(cents: number): string {
  return `${grouped(cents, ".", ",")} EUR`;
}

/** Cents as a plain decimal text with a dot, for XML and PayPal: 1234.5 becomes "1234.50". */
export function decimalText(cents: number): string {
  return grouped(cents, "", ".");
}

/** Cents as a number of euros for libraries that want one. Exact for any realistic amount. */
export function toEuros(cents: number): number {
  return Number(decimalText(cents));
}
