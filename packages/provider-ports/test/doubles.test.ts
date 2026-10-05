import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PaymentProvider, PayoutProvider } from '../src/index.js';
import { isProviderError, providerPaymentRef, providerPayoutRef } from '../src/index.js';
import {
  DOUBLE_PAYMENT_REFERENCE,
  DOUBLE_PAYOUT_REFERENCE,
  PaymentProviderDouble,
  PayoutProviderDouble,
  doubleRefundRef,
} from '../src/testing/index.js';

/**
 * Phase 8-C — the test doubles.
 *
 * They exist so a later increment can exercise a payment or payout path without a provider. What matters
 * about them is that they are deterministic, that they contact nothing, that their defaults are the safe
 * answers rather than the convenient ones, and that they satisfy the ports structurally — a double that
 * had drifted from the interface would be useless as a stand-in.
 */

const RAW = { body: new Uint8Array([1, 2, 3]), headers: { 'x-signature': 'abc' } };
const MONEY = { amountMinor: '20000', currencyCode: 'XTS' };

describe('the payment double', () => {
  it('satisfies the port, including both optional methods', () => {
    const double: PaymentProvider = new PaymentProviderDouble();
    expect(typeof double.getCapabilities).toBe('function');
    expect(typeof double.createPayment).toBe('function');
    expect(typeof double.getPaymentStatus).toBe('function');
    expect(typeof double.refundPayment).toBe('function');
    expect(typeof double.getRefundStatus).toBe('function');
    expect(typeof double.cancelPayment).toBe('function');
    expect(typeof double.verifyWebhook).toBe('function');
    expect(typeof double.parseWebhook).toBe('function');
    expect(double.name).toBe('test_double');
  });

  it('is deterministic: the same construction answers the same way twice', async () => {
    const first = new PaymentProviderDouble();
    const second = new PaymentProviderDouble();
    expect(await first.createPayment({ amount: MONEY, idempotencyKey: 'key-1234', methodCode: null })).toEqual(
      await second.createPayment({ amount: MONEY, idempotencyKey: 'key-1234', methodCode: null }),
    );
  });

  it('defaults to the safe answer, not the convenient one', async () => {
    const double = new PaymentProviderDouble();
    // A refund is not supported unless a test says so, which is E-4's normalized answer.
    expect(await double.refundPayment({ reference: providerPaymentRef('p_1'), amount: MONEY, idempotencyKey: 'key-1234', reason: 'duplicate' })).toEqual({
      outcome: 'not_supported',
    });
    // A webhook is rejected unless a test says so: a double that verified anything would let a test pass
    // while asserting nothing about verification.
    const verification = await double.verifyWebhook(RAW);
    expect(verification.outcome).toBe('rejected');
    if (verification.outcome === 'rejected') expect(isProviderError(verification.error)).toBe(true);
    // An unknown reference is the default status, never a success.
    expect(await double.getPaymentStatus(providerPaymentRef('p_1'))).toEqual({ outcome: 'unknown_reference' });
    expect(await double.parseWebhook(RAW)).toEqual([]);
    expect(await double.getCapabilities()).toEqual({ currencies: [] });
  });

  it('records what it was called with, keeping amounts as strings', async () => {
    const double = new PaymentProviderDouble();
    await double.createPayment({ amount: MONEY, idempotencyKey: 'key-1234', methodCode: 'anything' });
    await double.getPaymentStatus(providerPaymentRef('p_1'));
    await double.getRefundStatus(doubleRefundRef());
    await double.cancelPayment(providerPaymentRef('p_1'));
    expect(double.calls.map((call) => call.method)).toEqual([
      'createPayment',
      'getPaymentStatus',
      'getRefundStatus',
      'cancelPayment',
    ]);
    expect(double.calls[0]).toEqual({
      method: 'createPayment',
      idempotencyKey: 'key-1234',
      amountMinor: '20000',
      currencyCode: 'XTS',
    });
  });

  it('returns whatever outcome a test configures, across the whole result surface', async () => {
    const configured = new PaymentProviderDouble({
      name: 'configured_double',
      createPayment: {
        outcome: 'created',
        reference: providerPaymentRef('p_2'),
        status: 'requires_action',
        nextAction: 'redirect',
        expiresAt: new Date(0),
      },
      paymentStatus: {
        outcome: 'status',
        reference: providerPaymentRef('p_2'),
        status: 'succeeded',
        observedAmount: MONEY,
        failureCode: null,
      },
      refund: { outcome: 'accepted', reference: doubleRefundRef(), status: 'pending' },
      verification: PaymentProviderDouble.verified(RAW),
      events: [
        {
          eventKey: 'evt_1',
          eventType: 'anything.the.provider.calls.it',
          reference: providerPaymentRef('p_2'),
          status: 'succeeded',
          observedAmount: MONEY,
          failureCode: null,
        },
      ],
    });
    expect(configured.name).toBe('configured_double');
    const created = await configured.createPayment({ amount: MONEY, idempotencyKey: 'key-1234', methodCode: null });
    expect(created.outcome === 'created' && created.nextAction).toBe('redirect');
    const status = await configured.getPaymentStatus(providerPaymentRef('p_2'));
    expect(status.outcome === 'status' && status.status).toBe('succeeded');
    const verified = await configured.verifyWebhook(RAW);
    expect(verified.outcome).toBe('verified');
    if (verified.outcome === 'verified') expect(verified.request.body).toEqual(RAW.body);
    expect((await configured.parseWebhook(RAW))[0]?.eventKey).toBe('evt_1');
  });

  it('issues a reference no provider could, so a double is never mistaken for one', () => {
    expect(DOUBLE_PAYMENT_REFERENCE).toContain('test-double');
    expect(DOUBLE_PAYOUT_REFERENCE).toContain('test-double');
  });
});

describe('the payout double', () => {
  it('satisfies the port, including all seven optional methods', () => {
    const double: PayoutProvider = new PayoutProviderDouble();
    for (const method of [
      'getCapabilities',
      'validateDestination',
      'registerDestination',
      'createPayout',
      'getPayoutStatus',
      'cancelPayout',
      'reversePayout',
      'verifyWebhook',
      'parseWebhook',
    ]) {
      expect(typeof (double as unknown as Record<string, unknown>)[method], method).toBe('function');
    }
  });

  it('defaults to not_supported and unknown_reference, never to a paid payout', async () => {
    const double = new PayoutProviderDouble();
    const destination = { destinationKind: 'bank_account', currencyCode: 'XTS', countryCode: 'ZZ', providerToken: null } as const;
    expect(await double.validateDestination(destination)).toEqual({ outcome: 'not_supported' });
    expect(await double.registerDestination(destination)).toEqual({ outcome: 'not_supported' });
    expect(await double.cancelPayout(providerPayoutRef('o_1'))).toEqual({ outcome: 'not_supported' });
    expect(await double.reversePayout(providerPayoutRef('o_1'))).toEqual({ outcome: 'not_supported' });
    expect(await double.getPayoutStatus(providerPayoutRef('o_1'))).toEqual({ outcome: 'unknown_reference' });
    const created = await double.createPayout({ amount: MONEY, idempotencyKey: 'key-1234', destination });
    expect(created.outcome === 'created' && created.status).toBe('pending');
  });

  it('records its calls with the currency it was given', async () => {
    const double = new PayoutProviderDouble();
    await double.createPayout({
      amount: MONEY,
      idempotencyKey: 'key-5678',
      destination: { destinationKind: 'wallet', currencyCode: 'XTS', countryCode: null, providerToken: null },
    });
    expect(double.calls[0]).toEqual({
      method: 'createPayout',
      idempotencyKey: 'key-5678',
      amountMinor: '20000',
      currencyCode: 'XTS',
    });
  });
});

describe('the doubles are inert', () => {
  it('hold no credential, reach no network and read no environment', async () => {
    const text = readFileSync(new URL('../src/testing/index.ts', import.meta.url), 'utf8');
    for (const term of ['fetch(', 'https://', 'process.env', 'apiKey', 'secret', 'Math.random', 'Date.now', 'setTimeout']) {
      expect(text.toLowerCase().includes(term.toLowerCase()), `the doubles mention ${term}`).toBe(false);
    }
  });

  it('are reachable only through their own entry point, never through the package root', async () => {
    const root = await import('../src/index.js');
    for (const exported of Object.keys(root)) {
      expect(exported).not.toContain('Double');
    }
  });
});
