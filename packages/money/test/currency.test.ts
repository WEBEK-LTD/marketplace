import { describe, expect, it } from 'vitest';
import { defineCurrency, isCurrencyCode, Money, MoneyError, toCurrencyCode } from '../src/index.js';
import { EGP } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

describe('currency definitions', () => {
  it('accepts three upper-case letters and 0 to 4 decimal places', () => {
    for (const minorUnit of [0, 1, 2, 3, 4]) {
      expect(defineCurrency('EGP', minorUnit).minorUnit).toBe(minorUnit);
    }
    expect(EGP.code).toBe('EGP');
  });

  it('rejects invalid codes', () => {
    for (const code of ['egp', 'EG', 'EGPP', 'EG1', '', ' EGP', 'É G']) {
      expect(isCurrencyCode(code)).toBe(false);
      expect(codeOf(() => toCurrencyCode(code))).toBe('INVALID_CURRENCY_CODE');
    }
    expect(isCurrencyCode(123)).toBe(false);
  });

  it('rejects decimal places outside 0 to 4', () => {
    for (const minorUnit of [-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => defineCurrency('EGP', minorUnit))).toBe('INVALID_MINOR_UNIT');
    }
  });

  it('returns frozen definitions', () => {
    expect(Object.isFrozen(EGP)).toBe(true);
  });

  it('rejects malformed definitions passed from untyped code', () => {
    const bad = { code: 'EGP', minorUnit: 7 } as never;
    expect(codeOf(() => Money.ofMinor(1n, bad))).toBe('INVALID_CURRENCY_DEFINITION');
  });

  it('treats two definitions of one code with different decimal places as an error', () => {
    const other = defineCurrency('EGP', 3);
    expect(codeOf(() => Money.ofMinor(1n, EGP).add(Money.ofMinor(1n, other)))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => Money.ofMinor(1n, EGP).equals(Money.ofMinor(1n, other)))).toBe('CURRENCY_MISMATCH');
  });
});
