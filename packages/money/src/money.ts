import { assertCurrencyDefinition, assertSameCurrency, isSameCurrency, type CurrencyDefinition } from './currency.js';
import { MoneyError } from './errors.js';
import { assertMinorAmountInRange } from './limits.js';

/** JSON form of a Money value. */
export interface MoneyJson {
  readonly amountMinor: string;
  readonly currency: string;
}

/**
 * An immutable amount in a currency's minor unit.
 * Amounts are signed whole numbers held as bigint; no floating point is ever used.
 */
export class Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyDefinition;

  private constructor(amountMinor: bigint, currency: CurrencyDefinition) {
    this.amountMinor = amountMinor;
    this.currency = currency;
    Object.freeze(this);
  }

  static ofMinor(amountMinor: bigint, currency: CurrencyDefinition): Money {
    if (typeof amountMinor !== 'bigint') {
      throw new MoneyError('INVALID_AMOUNT', 'Amounts must be bigint minor units.');
    }
    assertCurrencyDefinition(currency);
    return new Money(assertMinorAmountInRange(amountMinor), currency);
  }

  static zero(currency: CurrencyDefinition): Money {
    return Money.ofMinor(0n, currency);
  }

  static sum(currency: CurrencyDefinition, items: readonly Money[]): Money {
    let total = 0n;
    for (const item of items) {
      assertSameCurrency(currency, item.currency);
      total += item.amountMinor;
    }
    return Money.ofMinor(total, currency);
  }

  add(other: Money): Money {
    assertSameCurrency(this.currency, other.currency);
    return Money.ofMinor(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    assertSameCurrency(this.currency, other.currency);
    return Money.ofMinor(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return Money.ofMinor(-this.amountMinor, this.currency);
  }

  abs(): Money {
    return this.amountMinor < 0n ? this.negate() : this;
  }

  compare(other: Money): -1 | 0 | 1 {
    assertSameCurrency(this.currency, other.currency);
    if (this.amountMinor < other.amountMinor) return -1;
    if (this.amountMinor > other.amountMinor) return 1;
    return 0;
  }

  /** False for different currencies; throws only for conflicting definitions of one code. */
  equals(other: Money): boolean {
    return isSameCurrency(this.currency, other.currency) && this.amountMinor === other.amountMinor;
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  toJSON(): MoneyJson {
    return { amountMinor: this.amountMinor.toString(), currency: this.currency.code };
  }
}
