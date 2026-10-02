import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURRENCY_CODE_PATTERN,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  MINOR_AMOUNT_PATTERN,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_EXCEPTION_CASES,
  PAYMENT_NEXT_ACTIONS,
  PAYMENT_PROVIDER,
  PAYOUT_DESTINATION_KINDS,
  PAYOUT_PROVIDER,
  PAYOUT_STATUSES,
  PROVIDER_AMOUNT_FORMATS,
  PROVIDER_ERROR_CODE_PATTERN,
  PROVIDER_NAME_PATTERN,
  ProviderMoneyError,
  ProviderReferenceError,
  REFUND_STATUSES,
  UNCLASSIFIED_PROVIDER_ERROR_CODE,
  isCurrencyCodeString,
  isIdempotencyKey,
  isMinorAmountString,
  isPaymentAttemptStatus,
  isPaymentExceptionCase,
  isPaymentNextAction,
  isPayoutDestinationInput,
  isPayoutDestinationKind,
  isPayoutStatus,
  isProviderError,
  isProviderErrorCode,
  isProviderMoney,
  isProviderName,
  isProviderReference,
  isRawWebhookRequest,
  isRefundStatus,
  moneyJsonFromProviderMoney,
  providerError,
  providerMoney,
  providerMoneyFromMoneyJson,
  providerPaymentRef,
  providerPayoutRef,
  providerRefundRef,
} from '../src/index.js';

/**
 * Phase 8-C — the provider-neutral ports.
 *
 * No provider is contacted, no adapter exists and no credential appears. The assertions worth having here
 * are of three kinds: that every enum is exactly the value list its database CHECK constraint holds, read
 * from the committed migration rather than restated; that the guards refuse what the schema would refuse;
 * and that nothing provider-shaped has leaked into a normalized type.
 */

const MIGRATIONS = new URL('../../../supabase/migrations/', import.meta.url);
const sql = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8');

/** Reads the value list of a named CHECK constraint out of the migration that wrote it. */
function checkValues(file: string, constraint: string): string[] {
  const text = sql(file);
  const index = text.indexOf(`constraint ${constraint} check`);
  expect(index, `${constraint} exists in ${file}`).toBeGreaterThan(-1);
  const clause = text.slice(index, text.indexOf(')', text.indexOf(' in (', index)) + 1);
  const values = [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  expect(values.length, `${constraint} lists values`).toBeGreaterThan(1);
  return values;
}

describe('the enums are the database’s, not a copy that can drift', () => {
  it('payment attempt statuses match payment_attempts_status_allowed', () => {
    expect([...PAYMENT_ATTEMPT_STATUSES]).toEqual(
      checkValues('0019_payments_core.sql', 'payment_attempts_status_allowed'),
    );
  });

  it('next actions match payment_attempts_next_action_allowed', () => {
    expect([...PAYMENT_NEXT_ACTIONS]).toEqual(
      checkValues('0019_payments_core.sql', 'payment_attempts_next_action_allowed'),
    );
  });

  it('refund statuses match refunds_status_allowed', () => {
    expect([...REFUND_STATUSES]).toEqual(checkValues('0019_payments_core.sql', 'refunds_status_allowed'));
  });

  it('exception cases match payment_exception_cases_type_allowed', () => {
    expect([...PAYMENT_EXCEPTION_CASES]).toEqual(
      checkValues('0020_payment_exceptions_and_fees.sql', 'payment_exception_cases_type_allowed'),
    );
  });

  it('and the policy table lists the same five cases', () => {
    expect([...PAYMENT_EXCEPTION_CASES]).toEqual(
      checkValues('0020_payment_exceptions_and_fees.sql', 'payment_exception_policies_case_type_allowed'),
    );
  });

  it('payout statuses match payouts_status_allowed', () => {
    expect([...PAYOUT_STATUSES]).toEqual(checkValues('0022_payouts.sql', 'payouts_status_allowed'));
  });

  it('destination kinds match payout_destinations_kind_allowed', () => {
    expect([...PAYOUT_DESTINATION_KINDS]).toEqual(
      checkValues('0022_payouts.sql', 'payout_destinations_kind_allowed'),
    );
  });

  it('amount formats match both capability tables', () => {
    expect([...PROVIDER_AMOUNT_FORMATS]).toEqual(
      checkValues('0019_payments_core.sql', 'payment_provider_capabilities_amount_format_allowed'),
    );
    expect([...PROVIDER_AMOUNT_FORMATS]).toEqual(
      checkValues('0022_payouts.sql', 'payout_provider_capabilities_amount_format_allowed'),
    );
  });

  it('every array is frozen, so a caller cannot add a value the database would refuse', () => {
    for (const values of [
      PAYMENT_ATTEMPT_STATUSES,
      PAYMENT_NEXT_ACTIONS,
      PAYMENT_EXCEPTION_CASES,
      PAYOUT_STATUSES,
      REFUND_STATUSES,
      PAYOUT_DESTINATION_KINDS,
      PROVIDER_AMOUNT_FORMATS,
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
    }
  });

  it('the guards admit exactly those values and nothing else', () => {
    expect(PAYMENT_ATTEMPT_STATUSES.every(isPaymentAttemptStatus)).toBe(true);
    expect(PAYMENT_NEXT_ACTIONS.every(isPaymentNextAction)).toBe(true);
    expect(PAYMENT_EXCEPTION_CASES.every(isPaymentExceptionCase)).toBe(true);
    expect(PAYOUT_STATUSES.every(isPayoutStatus)).toBe(true);
    expect(REFUND_STATUSES.every(isRefundStatus)).toBe(true);
    expect(PAYOUT_DESTINATION_KINDS.every(isPayoutDestinationKind)).toBe(true);
    for (const guard of [isPaymentAttemptStatus, isPaymentNextAction, isPayoutStatus, isRefundStatus]) {
      expect(guard('authorized')).toBe(false);
      expect(guard('')).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard(1)).toBe(false);
    }
    // `authorized` is a `payments.status` value, never an attempt status. The two lists are different and
    // this asserts they have not been conflated.
    expect(PAYMENT_ATTEMPT_STATUSES).not.toContain('authorized');
    // A payout is never `requires_action`; a payment attempt never `processing`.
    expect(PAYOUT_STATUSES).not.toContain('requires_action');
    expect(PAYMENT_ATTEMPT_STATUSES).not.toContain('processing');
  });
});

describe('money never crosses as a number', () => {
  it('accepts a canonical whole number of minor units with an explicit currency code', () => {
    const amount = providerMoney('9007199254740993', 'XTS');
    expect(amount).toEqual({ amountMinor: '9007199254740993', currencyCode: 'XTS' });
    // The point of the string: this value is not representable exactly as a JavaScript number.
    expect(Number(amount.amountMinor).toString()).not.toBe(amount.amountMinor);
    expect(Object.isFrozen(amount)).toBe(true);
  });

  it('refuses anything that is not a canonical decimal digit string', () => {
    for (const bad of ['', ' 1', '1 ', '+1', '-1', '01', '1.0', '1e3', '1_000', 'one', '١٢٣']) {
      expect(isMinorAmountString(bad), bad).toBe(false);
      expect(() => providerMoney(bad, 'XTS')).toThrow(ProviderMoneyError);
    }
    expect(isMinorAmountString(1)).toBe(false);
    expect(isMinorAmountString(1n)).toBe(false);
    expect(isMinorAmountString(null)).toBe(false);
  });

  it('refuses a currency code that is not three upper-case letters', () => {
    for (const bad of ['', 'xts', 'XT', 'XTSD', 'X1S', ' XTS']) {
      expect(isCurrencyCodeString(bad), bad).toBe(false);
      expect(() => providerMoney('100', bad)).toThrow(ProviderMoneyError);
    }
  });

  it('admits zero, because a capability bound may be zero, and refuses a negative amount', () => {
    expect(isMinorAmountString('0')).toBe(true);
    expect(isMinorAmountString('-5')).toBe(false);
  });

  it('is recognised only with exactly the two expected keys', () => {
    expect(isProviderMoney({ amountMinor: '100', currencyCode: 'XTS' })).toBe(true);
    expect(isProviderMoney({ amountMinor: '100', currency: 'XTS' })).toBe(false);
    expect(isProviderMoney({ amountMinor: '100', currencyCode: 'XTS', extra: 1 })).toBe(false);
    expect(isProviderMoney({ amountMinor: 100, currencyCode: 'XTS' })).toBe(false);
    expect(isProviderMoney(null)).toBe(false);
    expect(isProviderMoney([])).toBe(false);
  });

  it('crosses the packages/money boundary explicitly, by renaming one key and nothing else', () => {
    const fromMoney = providerMoneyFromMoneyJson({ amountMinor: '12345', currency: 'XTS' });
    expect(fromMoney).toEqual({ amountMinor: '12345', currencyCode: 'XTS' });
    expect(moneyJsonFromProviderMoney(fromMoney)).toEqual({ amountMinor: '12345', currency: 'XTS' });
    // A negative MoneyJson amount is legal in packages/money and illegal here, so it is refused rather
    // than made positive.
    expect(() => providerMoneyFromMoneyJson({ amountMinor: '-1', currency: 'XTS' })).toThrow(ProviderMoneyError);
    // And the wrong key set does not quietly pass through.
    expect(() =>
      providerMoneyFromMoneyJson({ amountMinor: '1', currencyCode: 'XTS' } as unknown as { amountMinor: string; currency: string }),
    ).toThrow(ProviderMoneyError);
  });

  it('uses the same currency-code rule the database column holds', () => {
    expect(CURRENCY_CODE_PATTERN.source).toBe('^[A-Z]{3}$');
    expect(MINOR_AMOUNT_PATTERN.test('0')).toBe(true);
  });
});

describe('the normalized error model', () => {
  it('carries exactly a coarse code and a retryable flag', () => {
    const error = providerError('provider_timeout', true);
    expect(error).toEqual({ code: 'provider_timeout', retryable: true });
    expect(Object.keys(error).sort()).toEqual(['code', 'retryable']);
    expect(isProviderError(error)).toBe(true);
  });

  it('uses the failure_code rule the database enforces', () => {
    expect(PROVIDER_ERROR_CODE_PATTERN.source).toBe('^[a-z][a-z0-9_.]*$');
    const fromMigration = /failure_code is null or failure_code ~ '(\^\[a-z\]\[a-z0-9_\.\]\*\$)'/.exec(
      sql('0019_payments_core.sql'),
    );
    expect(fromMigration?.[1]).toBe('^[a-z][a-z0-9_.]*$');
  });

  it('degrades an unusable code instead of throwing, because a failure must stay recordable', () => {
    for (const bad of ['Provider_Timeout', 'provider timeout', '9lives', '', 'a'.repeat(200)]) {
      expect(isProviderErrorCode(bad), bad).toBe(false);
      expect(providerError(bad, true).code).toBe(UNCLASSIFIED_PROVIDER_ERROR_CODE);
    }
    // And the fallback itself is storable.
    expect(isProviderErrorCode(UNCLASSIFIED_PROVIDER_ERROR_CODE)).toBe(true);
  });

  it('is the same slug 7-D already uses for an unclassified provider failure', () => {
    expect(UNCLASSIFIED_PROVIDER_ERROR_CODE).toBe('provider_error_unclassified');
  });

  it('refuses a shape with anything beyond the two fields', () => {
    expect(isProviderError({ code: 'x', retryable: true, message: 'boom' })).toBe(false);
    expect(isProviderError({ code: 'x' })).toBe(false);
    expect(isProviderError({ code: 'x', retryable: 'yes' })).toBe(false);
  });
});

describe('identifiers', () => {
  it('keeps the three provider references distinct types with distinct field names', () => {
    expect(providerPaymentRef('p_1')).toEqual({ providerPaymentRef: 'p_1' });
    expect(providerRefundRef('r_1')).toEqual({ providerRefundRef: 'r_1' });
    expect(providerPayoutRef('o_1')).toEqual({ providerPayoutRef: 'o_1' });
  });

  it('refuses an empty or whitespace-only reference', () => {
    for (const bad of ['', ' ', '\t\n']) {
      expect(isProviderReference(bad)).toBe(false);
      expect(() => providerPaymentRef(bad)).toThrow(ProviderReferenceError);
      expect(() => providerRefundRef(bad)).toThrow(ProviderReferenceError);
      expect(() => providerPayoutRef(bad)).toThrow(ProviderReferenceError);
    }
    expect(isProviderReference(undefined)).toBe(false);
  });

  it('applies the 8 to 255 idempotency-key bound all three tables share', () => {
    expect([IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH]).toEqual([8, 255]);
    for (const table of ['payment_attempts', 'refunds']) {
      expect(sql('0019_payments_core.sql')).toContain(
        `constraint ${table}_idempotency_key_length check (length(idempotency_key) between 8 and 255)`,
      );
    }
    expect(sql('0022_payouts.sql')).toContain(
      'constraint payouts_idempotency_key_length check (length(idempotency_key) between 8 and 255)',
    );
    expect(isIdempotencyKey('a'.repeat(8))).toBe(true);
    expect(isIdempotencyKey('a'.repeat(255))).toBe(true);
    expect(isIdempotencyKey('a'.repeat(7))).toBe(false);
    expect(isIdempotencyKey('a'.repeat(256))).toBe(false);
    expect(isIdempotencyKey(undefined)).toBe(false);
  });

  it('names an adapter with the same rule a provider key uses', () => {
    expect(PROVIDER_NAME_PATTERN.source).toBe('^[a-z][a-z0-9_]*$');
    expect(sql('0019_payments_core.sql')).toContain(
      "constraint payment_providers_key_format check (key ~ '^[a-z][a-z0-9_]*$')",
    );
    expect(isProviderName('test_double')).toBe(true);
    expect(isProviderName('Test')).toBe(false);
    expect(isProviderName('has space')).toBe(false);
  });

  it('accepts a destination input with the identity the schema keeps, and refuses a broken one', () => {
    expect(
      isPayoutDestinationInput({
        destinationKind: 'bank_account',
        currencyCode: 'XTS',
        countryCode: 'ZZ',
        providerToken: null,
      }),
    ).toBe(true);
    expect(
      isPayoutDestinationInput({
        destinationKind: 'provider_token',
        currencyCode: 'XTS',
        countryCode: null,
        providerToken: 'tok_1',
      }),
    ).toBe(true);
    expect(isPayoutDestinationInput({ destinationKind: 'iban', currencyCode: 'XTS', countryCode: null, providerToken: null })).toBe(false);
    expect(isPayoutDestinationInput({ destinationKind: 'wallet', currencyCode: 'xts', countryCode: null, providerToken: null })).toBe(false);
    expect(isPayoutDestinationInput({ destinationKind: 'wallet', currencyCode: 'XTS', countryCode: 'ZZZ', providerToken: null })).toBe(false);
    expect(isPayoutDestinationInput(null)).toBe(false);
  });
});

describe('webhook requests', () => {
  it('carry bytes, because a signature is computed over the bytes a provider sent', () => {
    const request = { body: new Uint8Array([1, 2, 3]), headers: { 'x-signature': 'abc' } };
    expect(isRawWebhookRequest(request)).toBe(true);
    expect(isRawWebhookRequest({ body: 'raw', headers: {} })).toBe(false);
    expect(isRawWebhookRequest({ body: new Uint8Array(), headers: { n: 1 } })).toBe(false);
    expect(isRawWebhookRequest({ headers: {} })).toBe(false);
  });
});

describe('the ports themselves', () => {
  it('provide injection tokens, so an adapter is wired in rather than imported', () => {
    expect(typeof PAYMENT_PROVIDER).toBe('symbol');
    expect(typeof PAYOUT_PROVIDER).toBe('symbol');
    expect(PAYMENT_PROVIDER).not.toBe(PAYOUT_PROVIDER);
  });

  it('name no provider, credential, endpoint or environment variable anywhere in the package', async () => {
    const { readdir } = await import('node:fs/promises');
    const dir = new URL('../src/', import.meta.url);
    const names: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const nested of await readdir(new URL(`${entry.name}/`, dir))) names.push(`${entry.name}/${nested}`);
      } else names.push(entry.name);
    }
    expect(names.length).toBeGreaterThanOrEqual(7);
    const forbidden = [
      'kashier', 'fawaterk', 'paymob', 'stripe', 'adyen', 'checkout.com',
      'apiKey', 'api_key', 'secretKey', 'secret_key', 'baseUrl', 'base_url',
      'process.env', 'Authorization', 'fetch(', 'https://',
    ];
    for (const name of names) {
      const text = readFileSync(new URL(name, dir), 'utf8');
      for (const term of forbidden) {
        expect(text.toLowerCase().includes(term.toLowerCase()), `${name} mentions ${term}`).toBe(false);
      }
    }
  });
});
