import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPercentage, divideRoundHalfAwayFromZero, Money, MoneyError, parsePercentage } from '../src/index.js';
import { EGP, moderateAmount } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

describe('percentages', () => {
  it.each([
    ['14', 14_000_000n],
    ['2.75', 2_750_000n],
    ['0.125', 125_000n],
    ['12.345678', 12_345_678n],
    ['100', 100_000_000n],
    ['0', 0n],
    ['-0', 0n],
    ['-5', -5_000_000n],
  ])('parses %s', (text, scaled) => {
    expect(parsePercentage(text).scaled).toBe(scaled);
  });

  it('rejects more than 6 decimal places and malformed strings', () => {
    for (const text of ['1.2345678', '', '1e2', ' 1', '1 ', '+1', '1.', '.5', 'abc', '1,5', '١٤']) {
      expect(codeOf(() => parsePercentage(text))).toBe('INVALID_PERCENTAGE');
    }
    expect(codeOf(() => parsePercentage(14 as never))).toBe('INVALID_PERCENTAGE');
  });

  it.each([
    [1000n, '14', 140n],
    [1n, '50', 1n],
    [-1n, '50', -1n],
    [333n, '12.5', 42n],
    [-333n, '12.5', -42n],
    [100n, '0.5', 1n],
    [99n, '0.5', 0n],
    [12345n, '2.75', 339n],
    [1n, '0.000001', 0n],
  ])('%s minor × %s%% = %s', (amount, percentage, expected) => {
    expect(applyPercentage(Money.ofMinor(amount, EGP), percentage).amountMinor).toBe(expected);
  });

  it('detects results outside the bigint range', () => {
    const big = Money.ofMinor(9_000_000_000_000_000_000n, EGP);
    expect(codeOf(() => applyPercentage(big, '200'))).toBe('OUT_OF_RANGE');
  });

  it('property: matches exact rational arithmetic with half-away-from-zero rounding', () => {
    const percentageText = fc
      .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 1000n }), fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 0, max: 6 }))
      .map(([neg, whole, frac, digits]) => {
        const fraction = digits === 0 ? '' : `.${String(frac).padStart(6, '0').slice(0, digits)}`;
        return `${neg ? '-' : ''}${whole}${fraction}`;
      });
    fc.assert(
      fc.property(moderateAmount, percentageText, (amount, text) => {
        const [wholePart = '0', fractionPart = ''] = text.replace('-', '').split('.');
        const denominator = 100n * 10n ** BigInt(fractionPart.length);
        const numerator = BigInt(wholePart + fractionPart) * (text.startsWith('-') ? -1n : 1n);
        const expected = divideRoundHalfAwayFromZero(amount * numerator, denominator);
        const result = applyPercentage(Money.ofMinor(amount, EGP), text).amountMinor;
        expect(result).toBe(expected);
        expect(applyPercentage(Money.ofMinor(-amount, EGP), text).amountMinor).toBe(-result);
      }),
      { numRuns: 2000 },
    );
  });
});
