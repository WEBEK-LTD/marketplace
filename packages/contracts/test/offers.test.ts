import { describe, expect, it } from 'vitest';
import {
  CounterOfferRequestSchema,
  CreateOfferRequestSchema,
  OFFER_STATUSES,
  OfferDecisionResponseSchema,
  OfferMutationResponseSchema,
  OfferSchema,
  SellerOfferSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The offers contract (Phase 7-H).
 *
 * The assertions that matter are about absence. This is the shape a price negotiation and a payable
 * obligation travel in, so what the requests refuse to carry matters more than what the responses hold.
 */

const OFFER_CORE = {
  id: 'c0000000-0000-4000-8000-000000000001',
  listingId: 'c0000000-0000-4000-8000-0000000000f1',
  listingSlug: 'an-offerable-listing',
  listingTitle: 'An offerable listing',
  amountMinor: '430000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  quantity: 3,
  message: 'Meet me here',
  status: 'pending',
  isLapsed: false,
  expiresAt: '2026-05-03T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  parentOfferId: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const OFFER = { ...OFFER_CORE, sellerSlug: 'a-shop', sellerDisplayName: 'A Shop' };
const SELLER_OFFER = { ...OFFER_CORE, buyerDisplayName: 'A Buyer' };

describe('7-H the status vocabulary is 0015’s', () => {
  it('names the six statuses and no seventh', () => {
    expect(OFFER_STATUSES).toEqual([
      'pending',
      'accepted',
      'rejected',
      'countered',
      'withdrawn',
      'expired',
    ]);
  });

  it('refuses a status 0015 does not define', () => {
    for (const status of ['paid', 'open', 'draft', 'cancelled']) {
      expect(OfferSchema.safeParse({ ...OFFER, status }).success, status).toBe(false);
    }
  });
});

describe('7-H money', () => {
  it('is a decimal string of minor units with its authoritative decimal places', () => {
    expect(OfferSchema.safeParse(OFFER).success).toBe(true);
    expect(OfferSchema.safeParse({ ...OFFER, amountMinor: 430000 }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...OFFER, currencyMinorUnit: '2' }).success).toBe(false);
  });

  it('has no representable zero or negative amount, because the column forbids both', () => {
    for (const amountMinor of ['0', '-1', '0430000', '4300.00', '', 'lots']) {
      expect(CreateOfferRequestSchema.safeParse({ ...OFFER_CORE, listingId: OFFER.listingId, amountMinor }).success, amountMinor).toBe(
        false,
      );
    }
  });

  it('carries the currency beside the amount and never converts it', () => {
    const keys = Object.keys(OfferSchema.shape);
    expect(keys).toContain('currencyCode');
    expect(keys).toContain('currencyMinorUnit');
    // No converted, presentational or formatted amount: the minor units and the currency are the whole
    // of it, and any second representation would be a second thing to disagree.
    for (const key of keys) {
      for (const forbidden of ['converted', 'formatted', 'displayamount', 'amountdisplay', 'usd']) {
        expect(key.toLowerCase(), key).not.toContain(forbidden);
      }
    }
  });
});

describe('7-H what a request refuses to carry', () => {
  const create = { listingId: OFFER.listingId, amountMinor: '430000', quantity: 2 };

  it('accepts a listing, an amount, a quantity and a note, and nothing else', () => {
    expect(CreateOfferRequestSchema.safeParse(create).success).toBe(true);
    expect(CreateOfferRequestSchema.safeParse({ ...create, message: 'Please' }).success).toBe(true);

    for (const field of [
      'sellerUserId',
      'buyerUserId',
      'currencyCode',
      'expiresAt',
      'status',
      'acceptedAt',
      'acceptedTerms',
      'paymentDueAt',
      'respondedAt',
      'parentOfferId',
    ]) {
      expect(CreateOfferRequestSchema.safeParse({ ...create, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('never accepts a payment deadline anywhere in this module', () => {
    for (const schema of [CreateOfferRequestSchema, CounterOfferRequestSchema]) {
      expect(Object.keys(schema.shape)).not.toContain('paymentDueAt');
      expect(Object.keys(schema.shape)).not.toContain('paymentDueHours');
    }
  });

  it('gives a counter no way to name its parent', () => {
    expect(Object.keys(CounterOfferRequestSchema.shape).sort()).toEqual([
      'amountMinor',
      'message',
      'quantity',
    ]);
    for (const field of ['parentOfferId', 'offerId', 'listingId', 'sellerUserId', 'currencyCode']) {
      expect(
        CounterOfferRequestSchema.safeParse({ amountMinor: '440000', [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });

  it('defaults a quantity rather than leaving it to be guessed downstream', () => {
    const parsed = CreateOfferRequestSchema.safeParse({ listingId: OFFER.listingId, amountMinor: '430000' });
    expect(parsed.success && parsed.data.quantity).toBe(1);
  });

  it('refuses a quantity that is not a positive integer', () => {
    for (const quantity of [0, -1, 1.5, '2', null]) {
      expect(CreateOfferRequestSchema.safeParse({ ...create, quantity }).success, String(quantity)).toBe(
        false,
      );
    }
  });

  it('bounds the note to the column and refuses a blank one', () => {
    expect(CreateOfferRequestSchema.safeParse({ ...create, message: '   ' }).success).toBe(false);
    expect(CreateOfferRequestSchema.safeParse({ ...create, message: 'x'.repeat(2001) }).success).toBe(false);
    expect(CreateOfferRequestSchema.safeParse({ ...create, message: 'x'.repeat(2000) }).success).toBe(true);
  });
});

describe('7-H what a response carries', () => {
  it('names no account on either side', () => {
    for (const field of ['buyerUserId', 'sellerUserId', 'reviewedBy', 'userId']) {
      expect(OfferSchema.safeParse({ ...OFFER, [field]: OFFER.id }).success, field).toBe(false);
      expect(SellerOfferSchema.safeParse({ ...SELLER_OFFER, [field]: OFFER.id }).success, field).toBe(false);
    }
    expect(Object.keys(SellerOfferSchema.shape)).toContain('buyerDisplayName');
  });

  it('keeps the two deadlines as two fields', () => {
    const keys = Object.keys(OfferSchema.shape);
    expect(keys).toContain('expiresAt');
    expect(keys).toContain('paymentDueAt');
    // And neither is spelled as if it were the other.
    expect(keys.filter((key) => key.toLowerCase().includes('due'))).toEqual(['paymentDueAt']);
  });

  it('reports a lapsed window as a boolean rather than as a seventh status', () => {
    expect(OfferSchema.safeParse({ ...OFFER, isLapsed: true, status: 'pending' }).success).toBe(true);
    expect(OFFER_STATUSES).not.toContain('lapsed');
  });

  it('answers a decision with a status and the obligation, and nothing else', () => {
    expect(Object.keys(OfferDecisionResponseSchema.shape).sort()).toEqual([
      'acceptedAt',
      'paymentDueAt',
      'status',
    ]);
    expect(Object.keys(OfferMutationResponseSchema.shape).sort()).toEqual(['offerId', 'status']);
  });

  it('exports no shape that names a checkout, an order or a payment', async () => {
    const module = await import('../src/offers.js');
    for (const name of Object.keys(module)) {
      const lower = name.toLowerCase();
      for (const forbidden of ['checkout', 'order', 'payment_', 'pay', 'ledger', 'payout', 'refund']) {
        if (forbidden === 'pay') {
          // `payment` appears only in the two deadline-related names; a bare "pay" verb must not.
          expect(lower, name).not.toMatch(/(^|[^a-z])pay($|[^m])/);
          continue;
        }
        expect(lower, name).not.toContain(forbidden);
      }
    }
  });
});

describe('7-H the documented operations', () => {
  const doc = generateOpenApiDocument();

  it('documents two reads, one create and four named transitions', () => {
    const paths = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/offers'));
    expect(paths.sort()).toEqual([
      '/v1/offers',
      '/v1/offers/made',
      '/v1/offers/received',
      '/v1/offers/{offerId}/accept',
      '/v1/offers/{offerId}/counter',
      '/v1/offers/{offerId}/reject',
      '/v1/offers/{offerId}/withdraw',
    ]);
    expect(Object.keys(doc.paths?.['/v1/offers/made'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths?.['/v1/offers'] ?? {})).toEqual(['post']);
  });

  it('exposes no checkout, payment or order path under offers', () => {
    for (const path of Object.keys(doc.paths ?? {})) {
      if (!path.startsWith('/v1/offers')) continue;
      for (const word of ['checkout', 'pay', 'order', 'refund', 'ledger']) {
        expect(path, `${path} ${word}`).not.toContain(word);
      }
    }
  });

  it('takes no parameter anywhere that could name a person or a deadline', () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!path.startsWith('/v1/offers')) continue;
      for (const operation of Object.values(item ?? {})) {
        const names = ((operation as { parameters?: unknown[] }).parameters ?? []).map((parameter) =>
          typeof parameter === 'object' && parameter !== null && 'name' in parameter
            ? String((parameter as { name: unknown }).name).toLowerCase()
            : '',
        );
        for (const name of names) {
          for (const word of ['user', 'role', 'due', 'status', 'seller', 'buyer']) {
            expect(name, `${path} ${name} ${word}`).not.toContain(word);
          }
        }
      }
    }
  });

  it('documents the refusals a negotiation surface must have', () => {
    const accept = doc.paths?.['/v1/offers/{offerId}/accept']?.post;
    expect(accept?.responses?.['401']).toBeDefined();
    expect(accept?.responses?.['404']).toBeDefined();
    expect(accept?.responses?.['409']).toBeDefined();
    expect(accept?.responses?.['503']).toBeDefined();
  });
});
