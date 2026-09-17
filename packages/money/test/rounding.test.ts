import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { divideRoundHalfAwayFromZero } from '../src/index.js';

describe('half away from zero rounding (D14)', () => {
  it.each([
    [15n, 10n, 2n],
    [-15n, 10n, -2n],
    [25n, 10n, 3n],
    [-25n, 10n, -3n],
    [14n, 10n, 1n],
    [-14n, 10n, -1n],
    [16n, 10n, 2n],
    [-16n, 10n, -2n],
    [5n, 10n, 1n],
    [-5n, 10n, -1n],
    [4n, 10n, 0n],
    [-4n, 10n, 0n],
    [0n, 7n, 0n],
    [1n, 2n, 1n],
    [-1n, 2n, -1n],
  ])('%s / %s = %s', (n, d, expected) => {
    expect(divideRoundHalfAwayFromZero(n, d)).toBe(expected);
  });

  it('rejects non-positive denominators', () => {
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(RangeError);
    expect(() => divideRoundHalfAwayFromZero(1n, -1n)).toThrow(RangeError);
  });

  it('property: result is the nearest integer, ties away from zero, sign-symmetric', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (n, d) => {
        const r = divideRoundHalfAwayFromZero(n, d);
        // |n - r*d| * 2 <= d  (within half a unit)
        const diff = n - r * d;
        const absDiff = diff < 0n ? -diff : diff;
        expect(absDiff * 2n <= d).toBe(true);
        // exact ties go away from zero
        if (absDiff * 2n === d) {
          expect(r < 0n ? -r : r).toBe(((n < 0n ? -n : n) + d / 2n) / d);
          expect((r < 0n ? -r * d : r * d) > (n < 0n ? -n : n)).toBe(true);
        }
        expect(divideRoundHalfAwayFromZero(-n, d)).toBe(-r);
      }),
      { numRuns: 2000 },
    );
  });
});
