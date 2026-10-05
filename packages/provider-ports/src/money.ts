/**
 * Money as it crosses a provider port (Phase 8-C).
 *
 * A 64-bit minor amount exceeds what an IEEE double can hold exactly, so **no money field anywhere in
 * this package is a JavaScript number**. An amount is a decimal digit string and the currency travels
 * beside it, explicitly, never implied by context.
 *
 * The key is `currencyCode`, which is the convention every API-facing money field in this repository
 * uses. `packages/money` keeps its own `MoneyJson` shape — `{ amountMinor, currency }` — and is not
 * changed by this package. The two live side by side and the translation is explicit: see
 * {@link providerMoneyFromMoneyJson} and {@link moneyJsonFromProviderMoney}, which rename the key and do
 * nothing else. Neither performs arithmetic, parses a number, or resolves a currency definition — the
 * decimal places of a currency are `public.currencies`' business, and `Money` is where arithmetic lives.
 */
export interface ProviderMoney {
  /** A whole number of minor units, written in decimal with no sign, no separators and no leading zero. */
  readonly amountMinor: string;
  /** An ISO 4217 alphabetic code. */
  readonly currencyCode: string;
}

/**
 * Canonical non-negative whole number.
 *
 * Non-negative because every money column these ports touch is constrained that way: `amount_minor > 0`
 * on payments, attempts, refunds and payouts, and `>= 0` on the capability bounds. A negative provider
 * amount is not a value this contract can carry, and a reversal is its own operation rather than a
 * negative payout.
 */
export const MINOR_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** The same rule `packages/money` applies, and the same one `char(3)` columns hold. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isMinorAmountString(value: unknown): value is string {
  return typeof value === 'string' && MINOR_AMOUNT_PATTERN.test(value);
}

export function isCurrencyCodeString(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}

export function isProviderMoney(value: unknown): value is ProviderMoney {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currencyCode') return false;
  const { amountMinor, currencyCode } = value as { amountMinor: unknown; currencyCode: unknown };
  return isMinorAmountString(amountMinor) && isCurrencyCodeString(currencyCode);
}

export class ProviderMoneyError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderMoneyError';
  }
}

/** Builds a value that satisfies the contract, or refuses. Never rounds and never reinterprets. */
export function providerMoney(amountMinor: string, currencyCode: string): ProviderMoney {
  if (!isMinorAmountString(amountMinor)) {
    throw new ProviderMoneyError('A minor amount must be a whole number written in decimal.');
  }
  if (!isCurrencyCodeString(currencyCode)) {
    throw new ProviderMoneyError('A currency code must be three upper-case letters.');
  }
  return Object.freeze({ amountMinor, currencyCode });
}

/**
 * `packages/money`'s JSON shape, declared structurally.
 *
 * It is declared here rather than imported so that this package depends on nothing at all — no runtime
 * dependency, no type dependency, no workspace edge. The coupling is therefore a documented one: these two
 * fields are `MoneyJson` as `packages/money` defines it, and `packages/money` is not changed by 8-C. The
 * guards below check the key set at runtime, so a value that is not that shape is refused rather than
 * silently reinterpreted.
 */
export interface MoneyJsonLike {
  readonly amountMinor: string;
  readonly currency: string;
}

function isMoneyJsonLike(value: unknown): value is MoneyJsonLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') return false;
  const { amountMinor, currency } = value as { amountMinor: unknown; currency: unknown };
  return typeof amountMinor === 'string' && typeof currency === 'string';
}

/**
 * The boundary between the two representations, in the direction of the ports.
 *
 * `currency` becomes `currencyCode`. The digits are carried across untouched: a `MoneyJson` amount may be
 * negative and this contract may not hold one, so a negative amount is refused here rather than silently
 * made positive.
 */
export function providerMoneyFromMoneyJson(value: MoneyJsonLike): ProviderMoney {
  if (!isMoneyJsonLike(value)) {
    throw new ProviderMoneyError('Only a money JSON value with exactly amountMinor and currency can cross.');
  }
  return providerMoney(value.amountMinor, value.currency);
}

/** The same boundary, in the direction of `packages/money`. */
export function moneyJsonFromProviderMoney(value: ProviderMoney): MoneyJsonLike {
  if (!isProviderMoney(value)) {
    throw new ProviderMoneyError('Only a valid provider money value can cross to MoneyJson.');
  }
  return Object.freeze({ amountMinor: value.amountMinor, currency: value.currencyCode });
}
