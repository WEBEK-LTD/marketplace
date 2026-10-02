import { describe, expect, it } from 'vitest';
import {
  LISTINGS_DEFAULT_LIMIT,
  LISTINGS_MAX_LIMIT,
  LISTING_AVAILABILITY,
  ListingDetailResponseSchema,
  ListingSummarySchema,
  ListingsResponseSchema,
  parseListingsLimit,
} from '../src/index.js';

/**
 * The public listing contract (Phase 4-B).
 *
 * This is the boundary that decides what a browser is allowed to be told about a listing, so the tests
 * that matter are the ones about refusal: a field nobody approved, a price sent as a number, a status the
 * vocabulary does not contain. The schemas are strict, and these tests are what keeps them strict.
 */

const SUMMARY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'a-listing',
  title: 'A listing title',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
} as const;

const DETAIL = {
  ...SUMMARY,
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  createdAt: '2026-01-01T12:00:00.000Z',
  availability: 'available',
  category: { slug: 'furniture', name: 'Furniture' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [
    { key: 'width', label: 'Width', unit: 'cm', kind: 'number', text: '180', boolean: null, options: [] },
  ],
  tags: [{ slug: 'handmade', name: 'Handmade' }],
} as const;

describe('a listing summary', () => {
  it('accepts the approved card', () => {
    expect(ListingSummarySchema.safeParse(SUMMARY).success).toBe(true);
  });

  it('allows a listing with no city and no price', () => {
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, city: null, priceMinor: null }).success).toBe(true);
  });

  it('refuses every field the owner excluded', () => {
    for (const extra of [
      { sellerUserId: '22222222-2222-4222-8222-222222222222' },
      { viewCount: 12 },
      { status: 'active' },
      { location: 'POINT(31.2 30.0)' },
      { contactEmail: 'seller@example.com' },
      { contactPhoneE164: '+201000000000' },
      { legalName: 'Good Shop LLC' },
      { publishedAt: '2026-01-01T12:00:00.000Z' },
    ]) {
      expect(ListingSummarySchema.safeParse({ ...SUMMARY, ...extra }).success).toBe(false);
    }
  });

  it('carries the price as a string of minor units, never a number', () => {
    // A number would be rounded somewhere between here and a screen; a decimal string invites the same.
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, priceMinor: 250000 }).success).toBe(false);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, priceMinor: '2500.00' }).success).toBe(false);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, priceMinor: '-1' }).success).toBe(false);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, priceMinor: '007' }).success).toBe(false);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, priceMinor: '0' }).success).toBe(true);
  });

  it('carries the currency and its minor unit, so a client can format without guessing', () => {
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, currencyMinorUnit: 3 }).success).toBe(true);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, currencyMinorUnit: -1 }).success).toBe(false);
    expect(ListingSummarySchema.safeParse({ ...SUMMARY, currencyMinorUnit: 2.5 }).success).toBe(false);
  });
});

describe('a page of listings', () => {
  it('is a list plus a cursor, and nothing else', () => {
    expect(ListingsResponseSchema.safeParse({ items: [SUMMARY], nextCursor: null }).success).toBe(true);
    expect(ListingsResponseSchema.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    // No total: counting the whole catalogue on every page is not in the approved response.
    expect(ListingsResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
    expect(ListingsResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('a listing detail', () => {
  it('accepts the approved projection', () => {
    expect(ListingDetailResponseSchema.safeParse({ listing: DETAIL }).success).toBe(true);
  });

  it('knows exactly two availability values', () => {
    expect(LISTING_AVAILABILITY).toEqual(['available', 'no_longer_available']);
    for (const availability of LISTING_AVAILABILITY) {
      expect(ListingDetailResponseSchema.safeParse({ listing: { ...DETAIL, availability } }).success).toBe(true);
    }
    for (const bad of ['sold', 'archived', 'draft', 'expired', 'pending']) {
      expect(ListingDetailResponseSchema.safeParse({ listing: { ...DETAIL, availability: bad } }).success).toBe(false);
    }
  });

  it('projects a seller as a display name and a slug only', () => {
    const seller = { slug: 'good-shop', displayName: 'Good Shop' };
    expect(ListingDetailResponseSchema.safeParse({ listing: { ...DETAIL, seller } }).success).toBe(true);
    for (const extra of [
      { legalName: 'Good Shop LLC' },
      { userId: '22222222-2222-4222-8222-222222222222' },
      { contactEmail: 'seller@example.com' },
      { contactPhoneE164: '+201000000000' },
      { verificationStatus: 'verified' },
    ]) {
      expect(
        ListingDetailResponseSchema.safeParse({ listing: { ...DETAIL, seller: { ...seller, ...extra } } }).success,
      ).toBe(false);
    }
  });

  it('refuses a detail field the owner excluded', () => {
    for (const extra of [
      { sellerUserId: '22222222-2222-4222-8222-222222222222' },
      { viewCount: 12 },
      { status: 'active' },
      { location: 'POINT(31.2 30.0)' },
      { rejectionReason: 'spam' },
    ]) {
      expect(ListingDetailResponseSchema.safeParse({ listing: { ...DETAIL, ...extra } }).success).toBe(false);
    }
  });
});

describe('the page-size rule', () => {
  it('uses the approved default when none is given', () => {
    expect(LISTINGS_DEFAULT_LIMIT).toBe(20);
    expect(LISTINGS_MAX_LIMIT).toBe(50);
    expect(parseListingsLimit(undefined)).toEqual({ ok: true, limit: 20 });
    expect(parseListingsLimit('')).toEqual({ ok: true, limit: 20 });
  });

  it('accepts the whole approved range', () => {
    expect(parseListingsLimit('1')).toEqual({ ok: true, limit: 1 });
    expect(parseListingsLimit('50')).toEqual({ ok: true, limit: 50 });
  });

  it('refuses anything outside it rather than quietly clamping', () => {
    // Clamping would answer a request nobody made; a caller asking for 500 should be told no.
    for (const bad of ['0', '-1', '51', '500', '1.5', 'ten', ' 20', '20abc', '1e2']) {
      expect(parseListingsLimit(bad).ok).toBe(false);
    }
  });
});
