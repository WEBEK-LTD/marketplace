import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, MIN_MINOR_AMOUNT, Money, MoneyError, splitEvenly } from '../src/index.js';
import { EGP, moderateAmount } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

const amounts = (parts: readonly Money[]) => parts.map((p) => p.amountMinor);

describe('largest-remainder allocation (D14)', () => {
  it.each([
    [100n, [1, 1, 1], [34n, 33n, 33n]],
    [100n, [1, 1], [50n, 50n]],
    [5n, [1, 1], [3n, 2n]],
    [-5n, [1, 1], [-3n, -2n]],
    [10n, [3, 7], [3n, 7n]],
    [5n, [1, 2], [2n, 3n]],
    [2n, [1, 3], [0n, 2n]],
    [2n, [3, 1], [2n, 0n]],
    [1n, [1, 1, 2], [0n, 0n, 1n]],
    [7n, [0, 1], [0n, 7n]],
    [0n, [1, 2, 3], [0n, 0n, 0n]],
    [-100n, [1, 1, 1], [-34n, -33n, -33n]],
  ])('example %# (total %s)', (total, weights, expected) => {
    expect(amounts(allocate(Money.ofMinor(total, EGP), weights))).toEqual(expected);
  });

  it('breaks equal remainders by larger weight, then earlier position', () => {
    // 3 split by [2, 2, 1, 1] over total weight 6: exact shares 1, 1, 0.5, 0.5 -> leftover 1 -> earliest tied part
    expect(amounts(allocate(Money.ofMinor(3n, EGP), [2, 2, 1, 1]))).toEqual([1n, 1n, 1n, 0n]);
    // remainders tie between weight 1 and weight 3; larger weight wins even though it comes later
    expect(amounts(allocate(Money.ofMinor(2n, EGP), [1, 3]))).toEqual([0n, 2n]);
  });

  it('accepts bigint weights and handles the minimum amount', () => {
    const parts = allocate(Money.ofMinor(MIN_MINOR_AMOUNT, EGP), [1n, 1n]);
    expect(amounts(parts)).toEqual([MIN_MINOR_AMOUNT / 2n, MIN_MINOR_AMOUNT / 2n]);
  });

  it('rejects invalid weights', () => {
    const one = Money.ofMinor(1n, EGP);
    for (const weights of [[], [0], [0, 0], [-1, 2], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1], ['1'], [-1n]] as const) {
      expect(codeOf(() => allocate(one, weights as never))).toBe('INVALID_WEIGHTS');
    }
    expect(codeOf(() => allocate(one, 'x' as never))).toBe('INVALID_WEIGHTS');
  });

  it('splits evenly with extra units to the earliest parts', () => {
    expect(amounts(splitEvenly(Money.ofMinor(10n, EGP), 3))).toEqual([4n, 3n, 3n]);
    expect(amounts(splitEvenly(Money.ofMinor(-10n, EGP), 3))).toEqual([-4n, -3n, -3n]);
    for (const parts of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf(() => splitEvenly(Money.ofMinor(10n, EGP), parts))).toBe('INVALID_WEIGHTS');
    }
  });

  it('property: parts reconcile exactly, stay within one unit of the exact share, and are sign-symmetric', () => {
    const weights = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0));
    fc.assert(
      fc.property(moderateAmount, weights, (total, ws) => {
        const parts = allocate(Money.ofMinor(total, EGP), ws);
        expect(parts).toHaveLength(ws.length);
        expect(parts.reduce((s, p) => s + p.amountMinor, 0n)).toBe(total);
        const totalWeight = ws.reduce((s, w) => s + BigInt(w), 0n);
        parts.forEach((part, i) => {
          const w = BigInt(ws[i] ?? 0);
          if (w === 0n) expect(part.amountMinor).toBe(0n);
          // |part * W - total * w| < W
          const diff = part.amountMinor * totalWeight - total * w;
          expect((diff < 0n ? -diff : diff) < totalWeight).toBe(true);
          expect(part.currency).toBe(EGP);
        });
        const mirrored = allocate(Money.ofMinor(-total, EGP), ws);
        expect(amounts(mirrored)).toEqual(amounts(parts).map((a) => -a));
      }),
      { numRuns: 1000 },
    );
  });

  it('property: equal weights differ by at most one unit and larger parts come first', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.integer({ min: 1, max: 50 }), (total, n) => {
        const parts = amounts(splitEvenly(Money.ofMinor(total, EGP), n));
        const max = parts.reduce((a, b) => (b > a ? b : a));
        const min = parts.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 1n).toBe(true);
        expect([...parts].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(parts);
      }),
      { numRuns: 500 },
    );
  });
});
