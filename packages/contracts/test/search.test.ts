import { describe, expect, it } from 'vitest';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_RESULT_TYPES,
  SearchResponseSchema,
  SearchResultSchema,
  parseSearchLimit,
  parseSearchQuery,
} from '../src/index.js';

/**
 * The public search contract (Phase 4-F, V1).
 *
 * A mixed result set is the one place where a loose contract would show up as a half-drawn card rather
 * than a visible failure, so most of these tests are about the union refusing anything that is not
 * exactly one of the two card shapes.
 */

const LISTING = {
  type: 'listing',
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'walnut-table',
  title: 'Walnut dining table',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
} as const;

const SERVICE = {
  type: 'service',
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'walnut-restoration',
  title: 'Walnut furniture restoration',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 14,
  revisionsIncluded: 1,
} as const;

describe('the discriminated result union', () => {
  it('knows exactly two result types', () => {
    expect(SEARCH_RESULT_TYPES).toEqual(['listing', 'service']);
  });

  it('accepts a listing result and a service result', () => {
    expect(SearchResultSchema.safeParse(LISTING).success).toBe(true);
    expect(SearchResultSchema.safeParse(SERVICE).success).toBe(true);
  });

  it('refuses a result with no type, or a type it does not know', () => {
    const { type: _listingType, ...listingWithoutType } = LISTING;
    expect(SearchResultSchema.safeParse(listingWithoutType).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...LISTING, type: 'seller' }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...LISTING, type: 'category' }).success).toBe(false);
  });

  it('holds each branch to its own surface contract', () => {
    // A listing carrying service fields, or the reverse, is not a valid result of either kind.
    expect(SearchResultSchema.safeParse({ ...LISTING, pricingModel: 'fixed' }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...LISTING, deliveryDays: 14 }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...SERVICE, isNegotiable: false }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...SERVICE, listingTypeCode: 'service' }).success).toBe(false);
  });

  it('refuses a listing result missing a card field, and a service result missing one', () => {
    const { isNegotiable: _n, ...listingShort } = LISTING;
    const { pricingModel: _p, ...serviceShort } = SERVICE;
    expect(SearchResultSchema.safeParse(listingShort).success).toBe(false);
    expect(SearchResultSchema.safeParse(serviceShort).success).toBe(false);
  });

  it('refuses every private or ranking field', () => {
    for (const extra of [
      { sellerUserId: '33333333-3333-4333-8333-333333333333' },
      { description: 'A solid walnut table.' },
      { rank: 0.42 },
      { score: 1 },
      { distanceMeters: 1200 },
      { promoted: true },
      { viewCount: 9 },
      { createdAt: '2026-01-01T12:00:00.000Z' },
    ]) {
      expect(SearchResultSchema.safeParse({ ...LISTING, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('allows a service result with nothing optional recorded', () => {
    const bare = { ...SERVICE, priceMinor: null, pricingModel: null, deliveryDays: null, revisionsIncluded: null };
    expect(SearchResultSchema.safeParse(bare).success).toBe(true);
  });
});

describe('the search response', () => {
  it('is a mixed list plus a cursor, and nothing else', () => {
    expect(SearchResponseSchema.safeParse({ items: [LISTING, SERVICE], nextCursor: null }).success).toBe(true);
    expect(SearchResponseSchema.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    // No total: counting every match on every page is not in the approved response.
    expect(SearchResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
    expect(SearchResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('refuses one bad result even when the others are fine', () => {
    const bad = { items: [LISTING, { ...SERVICE, type: 'seller' }], nextCursor: null };
    expect(SearchResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('the query rule', () => {
  it('requires at least the minimum number of characters after trimming', () => {
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(parseSearchQuery('ab')).toEqual({ ok: true, query: 'ab' });
    expect(parseSearchQuery('  walnut  ')).toEqual({ ok: true, query: 'walnut' });
    expect(parseSearchQuery('  ab  ')).toEqual({ ok: true, query: 'ab' });
  });

  it('refuses an empty or one-character query rather than browsing everything', () => {
    for (const bad of ['', ' ', '   ', 'a', ' a ', '\t\n']) {
      expect(parseSearchQuery(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses anything that is not a string', () => {
    for (const bad of [undefined, null, 2, ['ab'], {}]) {
      expect(parseSearchQuery(bad).ok, String(bad)).toBe(false);
    }
  });

  it('counts Unicode characters, not UTF-16 code units', () => {
    // Two emoji are four UTF-16 units but two characters; one emoji is two units but one character.
    expect(parseSearchQuery('😀😀').ok).toBe(true);
    expect(parseSearchQuery('😀').ok).toBe(false);
    // Arabic is counted the same way.
    expect(parseSearchQuery('كر').ok).toBe(true);
    expect(parseSearchQuery('ك').ok).toBe(false);
  });
});

describe('the page-size rule', () => {
  it('mirrors the browse surfaces', () => {
    expect(SEARCH_DEFAULT_LIMIT).toBe(20);
    expect(SEARCH_MAX_LIMIT).toBe(50);
    expect(parseSearchLimit(undefined)).toEqual({ ok: true, limit: 20 });
    expect(parseSearchLimit('50')).toEqual({ ok: true, limit: 50 });
  });

  it('refuses anything outside it rather than quietly clamping', () => {
    for (const bad of ['0', '-1', '51', '500', '1.5', 'ten', ' 20']) {
      expect(parseSearchLimit(bad).ok, bad).toBe(false);
    }
  });
});
