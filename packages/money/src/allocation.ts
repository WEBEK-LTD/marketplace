import { MoneyError } from './errors.js';
import { Money } from './money.js';

export type Weight = bigint | number;

function toWeight(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new MoneyError('INVALID_WEIGHTS', 'Weights must be whole numbers greater than or equal to 0.');
}

/**
 * Splits an amount by weights with the largest-remainder method (D14).
 * The parts always add up to the original amount exactly.
 * Equal remainders: the larger weight first, then the earlier position.
 * A negative amount is split by its absolute value and each part is negated.
 */
export function allocate(amount: Money, weights: readonly Weight[]): Money[] {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new MoneyError('INVALID_WEIGHTS', 'At least one weight is required.');
  }
  const parsed = weights.map(toWeight);
  const totalWeight = parsed.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    throw new MoneyError('INVALID_WEIGHTS', 'At least one weight must be greater than 0.');
  }

  const negative = amount.amountMinor < 0n;
  const magnitude = negative ? -amount.amountMinor : amount.amountMinor;

  const shares = parsed.map((weight) => (magnitude * weight) / totalWeight);
  const remainders = parsed.map((weight) => (magnitude * weight) % totalWeight);
  let leftover = magnitude - shares.reduce((sum, share) => sum + share, 0n);

  const order = parsed.map((_, index) => index);
  order.sort((a, b) => {
    const ra = remainders[a] ?? 0n;
    const rb = remainders[b] ?? 0n;
    if (ra !== rb) return ra > rb ? -1 : 1;
    const wa = parsed[a] ?? 0n;
    const wb = parsed[b] ?? 0n;
    if (wa !== wb) return wa > wb ? -1 : 1;
    return a - b;
  });

  if (leftover > BigInt(order.length)) {
    throw new Error('Allocation invariant violated.');
  }
  for (const index of order) {
    if (leftover === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return shares.map((share) => Money.ofMinor(negative ? -share : share, amount.currency));
}

/** Splits an amount into equal parts; extra minor units go to the earliest parts. */
export function splitEvenly(amount: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new MoneyError('INVALID_WEIGHTS', 'Number of parts must be a whole number of at least 1.');
  }
  return allocate(amount, new Array<number>(parts).fill(1));
}
