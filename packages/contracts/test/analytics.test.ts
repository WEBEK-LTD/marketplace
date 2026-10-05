import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AnalyticsCountSchema,
  LISTING_ANALYTICS_DEFAULT_DAYS,
  LISTING_ANALYTICS_DEFAULT_LIMIT,
  LISTING_ANALYTICS_MAX_DAYS,
  LISTING_ANALYTICS_MAX_LIMIT,
  ListingAnalyticsResponseSchema,
  ListingAnalyticsRowSchema,
  SellerListingAnalyticsResponseSchema,
  SellerListingPerformanceSchema,
} from '../src/index.js';

/**
 * The listing analytics contract (0102).
 *
 * Two properties carry the owner's corrections, and both are structural rather than enforced somewhere else:
 *
 *   * **a count is not money.** The counts use their own schema, which carries no currency, no decimal places
 *     and no dependency on the money package — so nothing downstream can render a click through a money
 *     formatter or put analytics on the currency rules;
 *   * **no field exists for anything this increment excludes.** There is no impressions field, no views field,
 *     no rate, no unique-visitor count, no source and no account identifier, so none of them can be sent or
 *     returned by accident.
 */

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'analytics.ts'), 'utf8');

/**
 * The same file with its documentation removed.
 *
 * A comment may name the money schema in order to say that this module does not use it; the code may not. The
 * distinction is the one `email-relay-boundary.test.ts` draws for provider names, and for the same reason.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SELLER_ROW = {
  listingSlug: 'a-chair',
  listingTitle: 'A chair',
  listingStatus: 'active',
  firstDay: '2026-09-24',
  lastDay: '2026-10-03',
  clicks: '12',
  contacts: '3',
  favorites: '0',
  shares: '0',
};

const STAFF_ROW = {
  day: '2026-10-03',
  listingSlug: 'a-chair',
  listingTitle: 'A chair',
  listingStatus: 'active',
  sellerSlug: 'good-shop',
  clicks: '12',
  contacts: '3',
  favorites: '0',
  shares: '0',
  computedAt: '2026-10-04T02:50:00.000Z',
};

describe('a count', () => {
  it('is a non-negative decimal integer string, because the database column is bigint', () => {
    for (const value of ['0', '1', '42', '4294967296', '9223372036854775807']) {
      expect(AnalyticsCountSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('refuses anything that is not one', () => {
    for (const value of ['', ' ', '-1', '01', '1.5', '1e3', '1 ', 'abc', '0x10', null, undefined, 12, {}]) {
      expect(AnalyticsCountSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  /**
   * The owner's correction, as a property of the module rather than a note in a comment: this file names no
   * money schema and no currency, so a count cannot acquire amount semantics by being passed along.
   */
  it('carries no currency, no amount semantics and no money dependency', () => {
    expect(CODE).not.toMatch(/MinorAmount/);
    expect(CODE).not.toMatch(/@repo\/money/);
    expect(CODE).not.toMatch(/from '\.\/listings\.js'/);
    expect(CODE).not.toMatch(/currencyCode|currencyMinorUnit|decimalPlaces/);
    expect(CODE).not.toMatch(/priceMinor|amountMinor/);
  });

  it('is its own schema, not an alias of the money one', async () => {
    const { MinorAmountSchema } = await import('../src/index.js');
    expect(AnalyticsCountSchema).not.toBe(MinorAmountSchema);
  });
});

describe('the seller’s listings', () => {
  it('accepts a row with the four counts', () => {
    expect(SellerListingPerformanceSchema.safeParse(SELLER_ROW).success).toBe(true);
  });

  it('requires all four, so a surface cannot quietly omit one', () => {
    for (const field of ['clicks', 'contacts', 'favorites', 'shares']) {
      const { [field]: _dropped, ...rest } = SELLER_ROW as Record<string, unknown>;
      expect(SellerListingPerformanceSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('refuses a count that is not a count', () => {
    expect(SellerListingPerformanceSchema.safeParse({ ...SELLER_ROW, clicks: 12 }).success).toBe(false);
    expect(SellerListingPerformanceSchema.safeParse({ ...SELLER_ROW, clicks: '-1' }).success).toBe(false);
  });

  /** Owner decisions 2 and 4, and the impression exclusion, as a shape rather than a rule. */
  it('has no field for anything this increment excludes', () => {
    for (const extra of [
      { impressions: '1' },
      { views: '1' },
      { clickThroughRate: '0.1' },
      { conversionRate: '0.1' },
      { uniqueVisitors: '1' },
      { uniqueSessions: '1' },
      { source: 'search' },
      { currencyCode: 'EGP' },
      { rank: 1 },
    ]) {
      expect(
        SellerListingPerformanceSchema.safeParse({ ...SELLER_ROW, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  /** A seller's own surface names their listing, never an identifier of any kind. */
  it('has no field for an identifier', () => {
    for (const extra of [
      { listingId: '11111111-1111-4111-8111-111111111111' },
      { sellerUserId: '11111111-1111-4111-8111-111111111111' },
      { userId: '11111111-1111-4111-8111-111111111111' },
      { sessionHash: 'ab'.repeat(32) },
    ]) {
      expect(
        SellerListingPerformanceSchema.safeParse({ ...SELLER_ROW, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(Object.keys(SELLER_ROW).some((key) => /id$/i.test(key))).toBe(false);
  });

  it('wraps rows in a response that states the window the server resolved', () => {
    expect(
      SellerListingAnalyticsResponseSchema.safeParse({ days: 30, listings: [SELLER_ROW] }).success,
    ).toBe(true);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ days: 30, listings: [] }).success).toBe(true);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ listings: [] }).success).toBe(false);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ days: 30 }).success).toBe(false);
  });

  it('bounds the window the way the database clamps it', () => {
    expect(LISTING_ANALYTICS_DEFAULT_DAYS).toBe(30);
    expect(LISTING_ANALYTICS_MAX_DAYS).toBe(365);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ days: 0, listings: [] }).success).toBe(false);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ days: 366, listings: [] }).success).toBe(false);
    expect(SellerListingAnalyticsResponseSchema.safeParse({ days: 1.5, listings: [] }).success).toBe(false);
  });

  it('carries no cursor: a seller reads their own listings whole', () => {
    expect(
      SellerListingAnalyticsResponseSchema.safeParse({ days: 30, listings: [], nextCursor: null }).success,
    ).toBe(false);
  });
});

describe('the staff page', () => {
  it('accepts a day of one listing', () => {
    expect(ListingAnalyticsRowSchema.safeParse(STAFF_ROW).success).toBe(true);
  });

  /** A seller is named by their storefront's public address, which is how every console names one. */
  it('names a seller by slug, and allows none for a listing whose owner has no storefront', () => {
    expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, sellerSlug: null }).success).toBe(true);
    expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, sellerSlug: '' }).success).toBe(false);
  });

  it('has no field for an account, a session or a raw event', () => {
    for (const extra of [
      { sellerUserId: '11111111-1111-4111-8111-111111111111' },
      { userId: '11111111-1111-4111-8111-111111111111' },
      { listingId: '11111111-1111-4111-8111-111111111111' },
      { sessionHash: 'ab'.repeat(32) },
      { eventId: '11111111-1111-4111-8111-111111111111' },
      { referrerHost: 'example.test' },
      { promotionId: '11111111-1111-4111-8111-111111111111' },
    ]) {
      expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('has no field for an impression, a view or a rate here either', () => {
    for (const extra of [{ impressions: '1' }, { views: '1' }, { ctr: '0.1' }, { score: 1 }]) {
      expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('pages with an opaque cursor', () => {
    expect(
      ListingAnalyticsResponseSchema.safeParse({ days: 30, items: [STAFF_ROW], nextCursor: null }).success,
    ).toBe(true);
    expect(
      ListingAnalyticsResponseSchema.safeParse({ days: 30, items: [], nextCursor: 'b3BhcXVl' }).success,
    ).toBe(true);
    // The field is required, so a surface cannot forget to report that there is more.
    expect(ListingAnalyticsResponseSchema.safeParse({ days: 30, items: [] }).success).toBe(false);
    expect(ListingAnalyticsResponseSchema.safeParse({ days: 30, items: [], nextCursor: '' }).success).toBe(false);
  });

  it('bounds the page size the way the database clamps it', () => {
    expect(LISTING_ANALYTICS_DEFAULT_LIMIT).toBe(25);
    expect(LISTING_ANALYTICS_MAX_LIMIT).toBe(100);
  });

  it('refuses a listing status the catalogue does not have', () => {
    expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, listingStatus: 'promoted' }).success).toBe(false);
    expect(ListingAnalyticsRowSchema.safeParse({ ...STAFF_ROW, listingStatus: 'archived' }).success).toBe(true);
  });
});

describe('what the module itself does not mention', () => {
  /** Nothing financial, and nothing from the ranking vocabulary. */
  it('names no financial path and no ranking concept', () => {
    for (const forbidden of [
      'payout',
      'settlement',
      'refund',
      'balance',
      'payment',
      'ledger',
      'provider',
      'ranking',
      'boost',
      'promoted',
    ]) {
      expect(CODE.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('names no impression, view, rate or session concept in a field', () => {
    // The prose explains why they are absent, so the assertion is on the field names rather than the text.
    const fields = [
      ...Object.keys(ListingAnalyticsRowSchema.shape),
      ...Object.keys(SellerListingPerformanceSchema.shape),
    ];
    for (const field of fields) {
      expect(field).not.toMatch(/impression|view|rate|session|unique|source/i);
    }
  });
});
