import { MoneyError } from './errors.js';

/**
 * Every *_minor amount is stored in a PostgreSQL bigint column,
 * so every Money value must fit in a signed 64-bit integer.
 */
export const MIN_MINOR_AMOUNT: bigint = -(2n ** 63n);
export const MAX_MINOR_AMOUNT: bigint = 2n ** 63n - 1n;

export function assertMinorAmountInRange(value: bigint): bigint {
  if (value < MIN_MINOR_AMOUNT || value > MAX_MINOR_AMOUNT) {
    throw new MoneyError('OUT_OF_RANGE', 'Amount is outside the PostgreSQL bigint range.');
  }
  return value;
}
