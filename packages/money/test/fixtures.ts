import fc from 'fast-check';
import { defineCurrency, MAX_MINOR_AMOUNT, MIN_MINOR_AMOUNT, type CurrencyDefinition } from '../src/index.js';

// Currency definitions exist only as test data; the package itself has none.
export const EGP: CurrencyDefinition = defineCurrency('EGP', 2);
export const USD: CurrencyDefinition = defineCurrency('USD', 2);
export const JPY: CurrencyDefinition = defineCurrency('JPY', 0);
export const KWD: CurrencyDefinition = defineCurrency('KWD', 3);
export const CLF: CurrencyDefinition = defineCurrency('CLF', 4);
export const ALL_TEST_CURRENCIES = [EGP, USD, JPY, KWD, CLF] as const;

export const anyMinorAmount = fc.bigInt({ min: MIN_MINOR_AMOUNT, max: MAX_MINOR_AMOUNT });
export const moderateAmount = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
export const anyTestCurrency = fc.constantFrom(...ALL_TEST_CURRENCIES);
