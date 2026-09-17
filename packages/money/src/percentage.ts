import { MoneyError } from './errors.js';
import { Money } from './money.js';
import { divideRoundHalfAwayFromZero } from './rounding.js';

export const MAX_PERCENTAGE_DECIMALS = 6;

const PERCENTAGE_SCALE = 10n ** BigInt(MAX_PERCENTAGE_DECIMALS);
const PERCENT_DENOMINATOR = 100n * PERCENTAGE_SCALE;
const PERCENTAGE_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A percentage given as a decimal string with at most 6 decimal places ("14" means 14%). */
export interface Percentage {
  /** The percentage multiplied by 10^6. */
  readonly scaled: bigint;
}

export function parsePercentage(text: string): Percentage {
  if (typeof text !== 'string') {
    throw new MoneyError('INVALID_PERCENTAGE', 'Percentage must be a decimal string.');
  }
  const match = PERCENTAGE_PATTERN.exec(text);
  if (match === null) {
    throw new MoneyError('INVALID_PERCENTAGE', 'Percentage must look like "14" or "2.75".');
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (fraction.length > MAX_PERCENTAGE_DECIMALS) {
    throw new MoneyError('INVALID_PERCENTAGE', 'Percentage allows at most 6 decimal places.');
  }
  const magnitude = BigInt(whole) * PERCENTAGE_SCALE + BigInt(fraction.padEnd(MAX_PERCENTAGE_DECIMALS, '0'));
  return Object.freeze({ scaled: sign === '-' ? -magnitude : magnitude });
}

/** Applies a percentage to an amount, rounding half away from zero (D14). */
export function applyPercentage(amount: Money, percentage: string | Percentage): Money {
  const parsed = typeof percentage === 'string' ? parsePercentage(percentage) : percentage;
  const product = amount.amountMinor * parsed.scaled;
  return Money.ofMinor(divideRoundHalfAwayFromZero(product, PERCENT_DENOMINATOR), amount.currency);
}
