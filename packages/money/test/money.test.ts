import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_MINOR_AMOUNT, MIN_MINOR_AMOUNT, Money, MoneyError } from '../src/index.js';
import { anyMinorAmount, EGP, moderateAmount, USD } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'NOT_MONEY_ERROR';
  }
  return undefined;
}

describe('Money', () => {
  it('accepts negative, zero and positive bigint amounts', () => {
    expect(Money.ofMinor(-150n, EGP).amountMinor).toBe(-150n);
    expect(Money.zero(EGP).isZero()).toBe(true);
    expect(Money.ofMinor(1n, EGP).isPositive()).toBe(true);
    expect(Money.ofMinor(-1n, EGP).isNegative()).toBe(true);
  });

  it('rejects non-bigint amounts, including floats', () => {
    for (const value of [1, 1.5, '1', Number.NaN, null, undefined]) {
      expect(codeOf(() => Money.ofMinor(value as never, EGP))).toBe('INVALID_AMOUNT');
    }
  });

  it('enforces the PostgreSQL bigint range', () => {
    expect(Money.ofMinor(MAX_MINOR_AMOUNT, EGP).amountMinor).toBe(9223372036854775807n);
    expect(Money.ofMinor(MIN_MINOR_AMOUNT, EGP).amountMinor).toBe(-9223372036854775808n);
    expect(codeOf(() => Money.ofMinor(MAX_MINOR_AMOUNT + 1n, EGP))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => Money.ofMinor(MIN_MINOR_AMOUNT - 1n, EGP))).toBe('OUT_OF_RANGE');
  });

  it('detects overflow in arithmetic', () => {
    const max = Money.ofMinor(MAX_MINOR_AMOUNT, EGP);
    const min = Money.ofMinor(MIN_MINOR_AMOUNT, EGP);
    expect(codeOf(() => max.add(Money.ofMinor(1n, EGP)))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => min.subtract(Money.ofMinor(1n, EGP)))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => min.negate())).toBe('OUT_OF_RANGE');
    expect(codeOf(() => min.abs())).toBe('OUT_OF_RANGE');
    expect(codeOf(() => Money.sum(EGP, [max, max]))).toBe('OUT_OF_RANGE');
  });

  it('never mixes currencies', () => {
    const egp = Money.ofMinor(100n, EGP);
    const usd = Money.ofMinor(100n, USD);
    expect(codeOf(() => egp.add(usd))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => egp.subtract(usd))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => egp.compare(usd))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => Money.sum(EGP, [egp, usd]))).toBe('CURRENCY_MISMATCH');
    expect(egp.equals(usd)).toBe(false);
  });

  it('is immutable', () => {
    const value = Money.ofMinor(100n, EGP);
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (value as { amountMinor: bigint }).amountMinor = 5n;
    }).toThrow(TypeError);
    const sum = value.add(Money.ofMinor(1n, EGP));
    expect(value.amountMinor).toBe(100n);
    expect(sum.amountMinor).toBe(101n);
  });

  it('compares and tests equality', () => {
    const a = Money.ofMinor(1n, EGP);
    const b = Money.ofMinor(2n, EGP);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(Money.ofMinor(1n, EGP))).toBe(0);
    expect(a.equals(Money.ofMinor(1n, EGP))).toBe(true);
    expect(a.equals(b)).toBe(false);
  });

  it('property: add and subtract are exact inverses', () => {
    fc.assert(
      fc.property(moderateAmount, moderateAmount, (x, y) => {
        const a = Money.ofMinor(x, EGP);
        const b = Money.ofMinor(y, EGP);
        expect(a.add(b).amountMinor).toBe(x + y);
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: negation is symmetric and sum matches bigint addition', () => {
    fc.assert(
      fc.property(fc.array(moderateAmount, { maxLength: 20 }), (values) => {
        const items = values.map((v) => Money.ofMinor(v, EGP));
        expect(Money.sum(EGP, items).amountMinor).toBe(values.reduce((s, v) => s + v, 0n));
        for (const item of items) {
          expect(item.negate().negate().equals(item)).toBe(true);
          expect(item.abs().amountMinor >= 0n).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('property: any in-range amount is accepted unchanged', () => {
    fc.assert(
      fc.property(anyMinorAmount, (x) => {
        expect(Money.ofMinor(x, EGP).amountMinor).toBe(x);
      }),
      { numRuns: 1000 },
    );
  });
});
