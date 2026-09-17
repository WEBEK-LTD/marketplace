import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money, MoneyError, moneyFromJson, moneyToJson, type CurrencyResolver } from '../src/index.js';
import { ALL_TEST_CURRENCIES, anyMinorAmount, anyTestCurrency, EGP } from './fixtures.js';

const resolve: CurrencyResolver = (code) => ALL_TEST_CURRENCIES.find((c) => c.code === code);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

describe('Money JSON', () => {
  it('serialises to the approved shape with a string amount', () => {
    const money = Money.ofMinor(-9223372036854775808n, EGP);
    expect(moneyToJson(money)).toEqual({ amountMinor: '-9223372036854775808', currency: 'EGP' });
    expect(JSON.stringify(money)).toBe('{"amountMinor":"-9223372036854775808","currency":"EGP"}');
  });

  it('reads valid JSON', () => {
    const money = moneyFromJson(JSON.parse('{"currency":"EGP","amountMinor":"1250"}'), resolve);
    expect(money.amountMinor).toBe(1250n);
    expect(money.currency).toBe(EGP);
  });

  it.each([
    ['not an object', 'x', 'INVALID_JSON'],
    ['null', null, 'INVALID_JSON'],
    ['array', ['1', 'EGP'], 'INVALID_JSON'],
    ['number amount', { amountMinor: 1250, currency: 'EGP' }, 'INVALID_JSON'],
    ['float string', { amountMinor: '12.50', currency: 'EGP' }, 'INVALID_JSON'],
    ['leading zero', { amountMinor: '01', currency: 'EGP' }, 'INVALID_JSON'],
    ['negative zero', { amountMinor: '-0', currency: 'EGP' }, 'INVALID_JSON'],
    ['plus sign', { amountMinor: '+1', currency: 'EGP' }, 'INVALID_JSON'],
    ['whitespace', { amountMinor: ' 1', currency: 'EGP' }, 'INVALID_JSON'],
    ['exponent', { amountMinor: '1e3', currency: 'EGP' }, 'INVALID_JSON'],
    ['missing currency', { amountMinor: '1' }, 'INVALID_JSON'],
    ['extra key', { amountMinor: '1', currency: 'EGP', scale: 2 }, 'INVALID_JSON'],
    ['bad code', { amountMinor: '1', currency: 'egp' }, 'INVALID_JSON'],
    ['unknown currency', { amountMinor: '1', currency: 'ZZZ' }, 'UNKNOWN_CURRENCY'],
    ['out of range', { amountMinor: '9223372036854775808', currency: 'EGP' }, 'OUT_OF_RANGE'],
  ])('rejects %s', (_label, value, expected) => {
    expect(codeOf(() => moneyFromJson(value, resolve))).toBe(expected);
  });

  it('rejects a resolver that returns the wrong currency', () => {
    expect(codeOf(() => moneyFromJson({ amountMinor: '1', currency: 'USD' }, () => EGP))).toBe('UNKNOWN_CURRENCY');
  });

  it('property: JSON round-trips exactly', () => {
    fc.assert(
      fc.property(anyMinorAmount, anyTestCurrency, (amount, currency) => {
        const money = Money.ofMinor(amount, currency);
        const restored = moneyFromJson(JSON.parse(JSON.stringify(money)), resolve);
        expect(restored.equals(money)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
