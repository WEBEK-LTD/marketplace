import type { CurrencyDefinition } from './currency.js';
import { MoneyError } from './errors.js';
import { Money } from './money.js';

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Converts a plain decimal string (e.g. "12.50") into Money.
 * More decimal places than the currency allows are rejected, never rounded.
 */
export function parseDecimalAmount(text: string, currency: CurrencyDefinition): Money {
  if (typeof text !== 'string') {
    throw new MoneyError('INVALID_DECIMAL', 'Amount must be a decimal string.');
  }
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    throw new MoneyError('INVALID_DECIMAL', 'Amount must look like "12" or "12.50".');
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (fraction.length > currency.minorUnit) {
    throw new MoneyError('EXCESS_PRECISION', `${currency.code} allows at most ${currency.minorUnit} decimal places.`);
  }
  const magnitude = BigInt(whole + fraction.padEnd(currency.minorUnit, '0'));
  return Money.ofMinor(sign === '-' ? -magnitude : magnitude, currency);
}

/** Canonical, non-localized decimal string (display formatting is out of scope). */
export function toDecimalString(amount: Money): string {
  const { minorUnit } = amount.currency;
  const negative = amount.amountMinor < 0n;
  const digits = (negative ? -amount.amountMinor : amount.amountMinor).toString().padStart(minorUnit + 1, '0');
  const sign = negative ? '-' : '';
  if (minorUnit === 0) {
    return `${sign}${digits}`;
  }
  return `${sign}${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
}
