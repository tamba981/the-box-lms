'use strict';

/**
 * One place that turns integer minor units into something a human reads.
 *
 * Why this module exists: money used to be formatted independently in the
 * course model (`"$14.99"`), the payment model, the dashboard revenue summary
 * and the payment emails (`"14.99 USD"`). The same $14.99 course could therefore
 * be advertised as "$14.99" in the catalogue and "14.99 USD" in the receipt,
 * and a third place emitted a bare "14.99" with no unit at all.
 *
 * Every amount in this codebase is an integer number of minor units (cents).
 * These helpers only run at the edge, when a value is about to be serialised or
 * written into an email — never in the middle of arithmetic.
 */

/** Currencies we can render with a symbol rather than a trailing code. */
const CURRENCY_SYMBOLS = Object.freeze({
  usd: '$',
  eur: '\u20ac',
  gbp: '\u00a3',
  lrd: 'L$',
});

/** Currencies whose minor unit is not 1/100 — kept explicit rather than assumed. */
const CURRENCY_EXPONENTS = Object.freeze({
  jpy: 0,
  krw: 0,
});

function normaliseCurrency(currency) {
  return String(currency || 'usd')
    .trim()
    .toLowerCase();
}

/**
 * Coerce anything into a whole number of minor units.
 *
 * Deliberately total rather than strict: this runs inside serialisers, and a
 * formatter that throws would turn one malformed row into a 500 for the whole
 * page. `NaN`/`null`/`undefined` become 0, and fractional input is rounded.
 */
function toMinorUnits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function minorUnitScale(currency) {
  const exponent = CURRENCY_EXPONENTS[normaliseCurrency(currency)];
  return Math.pow(10, exponent === undefined ? 2 : exponent);
}

/**
 * Render an integer amount of minor units, e.g. `formatCents(1499)` → "$14.99".
 *
 * Unknown currency codes fall back to a trailing code — "14.99 XYZ" — because
 * guessing a symbol would be worse than showing the code we were actually given.
 * Negative amounts are rendered as "-$5.00" so the sign is read before the
 * digits.
 */
function formatCents(cents, currency) {
  const code = normaliseCurrency(currency);
  const scale = minorUnitScale(code);
  const amount = toMinorUnits(cents) / scale;
  const digits = scale === 1 ? 0 : String(scale).length - 1;
  const magnitude = Math.abs(amount).toFixed(digits);
  const sign = amount < 0 ? '-' : '';
  const symbol = CURRENCY_SYMBOLS[code];

  if (symbol) return `${sign}${symbol}${magnitude}`;
  return `${sign}${magnitude} ${code.toUpperCase()}`;
}

/**
 * A course costs nothing, so it is displayed as "Free" rather than "$0.00".
 * This is a product decision about courses, not about money, which is why it
 * lives here as a distinct function rather than inside `formatCents`.
 */
function formatCentsOrFree(cents, currency) {
  return toMinorUnits(cents) === 0 ? 'Free' : formatCents(cents, currency);
}

/**
 * Fold `{ _id: currency, totalCents, payments }` aggregation rows — which is
 * what all the revenue pipelines group by — into a summary that refuses to
 * silently merge two different currencies.
 *
 * Totals in different currencies cannot be added: 1499 USD cents plus 1499 EUR
 * cents is not 2998 of anything. The previous dashboard took `rows[0]` and
 * reported it as the grand total, so a second currency simply vanished from the
 * figure. Here the largest currency is presented as the headline and every
 * currency is listed alongside it, with `mixedCurrency` set when there is more
 * than one so the caller can say so out loud instead of quietly understating
 * the total.
 */
function summariseRevenueByCurrency(rows) {
  const currencies = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row._id)
    .map((row) => ({
      currency: normaliseCurrency(row._id),
      totalCents: toMinorUnits(row.totalCents),
      payments: toMinorUnits(row.payments),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const primary = currencies[0];

  return {
    totalCents: primary ? primary.totalCents : 0,
    totalLabel: formatCents(primary ? primary.totalCents : 0, primary ? primary.currency : 'usd'),
    payments: primary ? primary.payments : 0,
    currency: primary ? primary.currency : 'usd',
    mixedCurrency: currencies.length > 1,
    currencies: currencies.map((entry) => ({
      ...entry,
      totalLabel: formatCents(entry.totalCents, entry.currency),
    })),
  };
}

module.exports = {
  CURRENCY_SYMBOLS,
  formatCents,
  formatCentsOrFree,
  normaliseCurrency,
  summariseRevenueByCurrency,
  toMinorUnits,
};
