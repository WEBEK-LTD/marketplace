import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money, MoneyError, parseDecimalAmount, toDecimalString } from '../src/index.js';
import { anyMinorAmount, anyTestCurrency, CLF, EGP, JPY, KWD } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

describe('decimal strings', () => {
  it.each([
    ['12.50', EGP, 1250n],
    ['12.5', EGP, 1250n],
    ['12', EGP, 1200n],
    ['0.01', EGP, 1n],
    ['-0.01', EGP, -1n],
    ['-0', EGP, 0n],
    ['007.10', EGP, 710n],
    ['12', JPY, 12n],
    ['1.234', KWD, 1234n],
    ['1.2345', CLF, 12345n],
  ])('parses %s', (text, currency, expected) => {
    expect(parseDecimalAmount(text, currency).amountMinor).toBe(expected);
  });

  it('rejects excess decimal places instead of rounding', () => {
    expect(codeOf(() => parseDecimalAmount('12.345', EGP))).toBe('EXCESS_PRECISION');
    expect(codeOf(() => parseDecimalAmount('12.500', EGP))).toBe('EXCESS_PRECISION');
    expect(codeOf(() => parseDecimalAmount('12.0', JPY))).toBe('EXCESS_PRECISION');
    expect(codeOf(() => parseDecimalAmount('1.23456', CLF))).toBe('EXCESS_PRECISION');
  });

  it('rejects malformed input', () => {
    for (const text of ['', '12.', '.5', '+12', '1e3', ' 12', '12 ', '1,000.00', 'abc', '--1', '١٢']) {
      expect(codeOf(() => parseDecimalAmount(text, EGP))).toBe('INVALID_DECIMAL');
    }
    expect(codeOf(() => parseDecimalAmount(12 as never, EGP))).toBe('INVALID_DECIMAL');
  });

  it('rejects values outside the bigint range', () => {
    expect(codeOf(() => parseDecimalAmount('92233720368547758.08', EGP))).toBe('OUT_OF_RANGE');
    expect(parseDecimalAmount('92233720368547758.07', EGP).amountMinor).toBe(9223372036854775807n);
  });

  it.each([
    [1250n, EGP, '12.50'],
    [-1n, EGP, '-0.01'],
    [0n, EGP, '0.00'],
    [5n, JPY, '5'],
    [-5n, JPY, '-5'],
    [1n, CLF, '0.0001'],
  ])('formats %s canonically', (amount, currency, expected) => {
    expect(toDecimalString(Money.ofMinor(amount, currency))).toBe(expected);
  });

  it('property: toDecimalString and parseDecimalAmount round-trip for every decimal-place setting', () => {
    fc.assert(
      fc.property(anyMinorAmount, anyTestCurrency, (amount, currency) => {
        const money = Money.ofMinor(amount, currency);
        expect(parseDecimalAmount(toDecimalString(money), currency).equals(money)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
