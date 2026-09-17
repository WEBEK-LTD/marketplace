import { MoneyError } from './errors.js';

declare const currencyCodeBrand: unique symbol;

/** An ISO 4217 alphabetic code (three upper-case letters). No currency is built in. */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };

/** Currency definitions are supplied at runtime (from the currencies table); none are hard-coded. */
export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  /** Number of decimal places of the minor unit: 0 to 4. */
  readonly minorUnit: number;
}

export const MIN_MINOR_UNIT = 0;
export const MAX_MINOR_UNIT = 4;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}

export function toCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new MoneyError('INVALID_CURRENCY_CODE', 'Currency code must be three upper-case letters (ISO 4217).');
  }
  return value;
}

function isValidMinorUnit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MINOR_UNIT &&
    value <= MAX_MINOR_UNIT
  );
}

export function defineCurrency(code: string, minorUnit: number): CurrencyDefinition {
  const validCode = toCurrencyCode(code);
  if (!isValidMinorUnit(minorUnit)) {
    throw new MoneyError('INVALID_MINOR_UNIT', 'Currency decimal places must be a whole number from 0 to 4.');
  }
  return Object.freeze({ code: validCode, minorUnit });
}

/** Validates a definition received from untyped code. */
export function assertCurrencyDefinition(value: unknown): asserts value is CurrencyDefinition {
  if (
    typeof value !== 'object' ||
    value === null ||
    !isCurrencyCode((value as { code?: unknown }).code) ||
    !isValidMinorUnit((value as { minorUnit?: unknown }).minorUnit)
  ) {
    throw new MoneyError('INVALID_CURRENCY_DEFINITION', 'Invalid currency definition.');
  }
}

/**
 * True when both definitions describe the same currency.
 * Two definitions with the same code but different decimal places are a data error.
 */
export function isSameCurrency(a: CurrencyDefinition, b: CurrencyDefinition): boolean {
  if (a.code !== b.code) {
    return false;
  }
  if (a.minorUnit !== b.minorUnit) {
    throw new MoneyError('CURRENCY_MISMATCH', `Conflicting definitions for currency ${a.code}.`);
  }
  return true;
}

export function assertSameCurrency(a: CurrencyDefinition, b: CurrencyDefinition): void {
  if (!isSameCurrency(a, b)) {
    throw new MoneyError('CURRENCY_MISMATCH', `Cannot combine ${a.code} with ${b.code}; there is no currency conversion.`);
  }
}
