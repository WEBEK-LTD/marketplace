import { isCurrencyCode, type CurrencyCode, type CurrencyDefinition } from './currency.js';
import { MoneyError } from './errors.js';
import { Money, type MoneyJson } from './money.js';

export type CurrencyResolver = (code: CurrencyCode) => CurrencyDefinition | undefined;

const CANONICAL_INTEGER = /^(?:0|-?[1-9]\d*)$/;

export function moneyToJson(amount: Money): MoneyJson {
  return amount.toJSON();
}

/**
 * Reads {"amountMinor": "<whole number string>", "currency": "<ISO code>"} strictly.
 * The currency definition comes from the caller (the currencies table), never from code.
 */
export function moneyFromJson(value: unknown, resolveCurrency: CurrencyResolver): Money {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MoneyError('INVALID_JSON', 'Money JSON must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') {
    throw new MoneyError('INVALID_JSON', 'Money JSON must have exactly "amountMinor" and "currency".');
  }
  const { amountMinor, currency } = value as { amountMinor: unknown; currency: unknown };
  if (typeof amountMinor !== 'string' || !CANONICAL_INTEGER.test(amountMinor)) {
    throw new MoneyError('INVALID_JSON', '"amountMinor" must be a whole number written as a string.');
  }
  if (!isCurrencyCode(currency)) {
    throw new MoneyError('INVALID_JSON', '"currency" must be an ISO 4217 code.');
  }
  const definition = resolveCurrency(currency);
  if (definition === undefined || definition.code !== currency) {
    throw new MoneyError('UNKNOWN_CURRENCY', `Currency ${currency} is not defined.`);
  }
  return Money.ofMinor(BigInt(amountMinor), definition);
}
