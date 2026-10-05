import { describe, expect, it } from 'vitest';
import {
  SERVICES_DEFAULT_LIMIT,
  SERVICES_MAX_LIMIT,
  SERVICE_PRICING_MODELS,
  ServiceDetailResponseSchema,
  ServiceSummarySchema,
  ServicesResponseSchema,
  isCanonicalSurface,
  parseServicesLimit,
} from '../src/index.js';

/**
 * The public service contract (Phase 4-C).
 *
 * This is the boundary that decides what a browser may be told about a service, so the tests that matter
 * are the ones about refusal: a field nobody approved, a price sent as a number, a pricing model the
 * vocabulary does not contain. The schemas are strict, and these tests are what keeps them strict.
 */

const SUMMARY = {
  id: '22220000-0000-4000-8000-000000000001',
  slug: 'logo-design',
  title: 'Logo design',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
} as const;

const DETAIL = {
  ...SUMMARY,
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  requiresBrief: true,
  scope: 'Three concepts, two rounds of revision.',
  availability: 'available',
  category: { slug: 'design', name: 'Design' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [],
  tags: [{ slug: 'remote', name: 'Remote' }],
} as const;

describe('a service summary', () => {
  it('accepts the approved card', () => {
    expect(ServiceSummarySchema.safeParse(SUMMARY).success).toBe(true);
  });

  it('allows a service with nothing recorded beyond the listing itself', () => {
    // `listing_service_details` is a separate row; a service without one states no pricing model,
    // no delivery time and no revision count rather than an invented default.
    const bare = {
      ...SUMMARY,
      city: null,
      priceMinor: null,
      pricingModel: null,
      deliveryDays: null,
      revisionsIncluded: null,
    };
    expect(ServiceSummarySchema.safeParse(bare).success).toBe(true);
  });

  it('knows exactly two pricing models', () => {
    expect(SERVICE_PRICING_MODELS).toEqual(['fixed', 'custom']);
    for (const pricingModel of SERVICE_PRICING_MODELS) {
      expect(ServiceSummarySchema.safeParse({ ...SUMMARY, pricingModel }).success).toBe(true);
    }
    for (const bad of ['hourly', 'quote', 'free', 'negotiable']) {
      expect(ServiceSummarySchema.safeParse({ ...SUMMARY, pricingModel: bad }).success).toBe(false);
    }
  });

  it('holds delivery days to the range the database enforces', () => {
    expect(ServiceSummarySchema.safeParse({ ...SUMMARY, deliveryDays: 1 }).success).toBe(true);
    expect(ServiceSummarySchema.safeParse({ ...SUMMARY, deliveryDays: 365 }).success).toBe(true);
    for (const bad of [0, -1, 366, 1.5]) {
      expect(ServiceSummarySchema.safeParse({ ...SUMMARY, deliveryDays: bad }).success, String(bad)).toBe(false);
    }
  });

  it('refuses every field the owner excluded', () => {
    for (const extra of [
      { sellerUserId: '11111111-1111-4111-8111-111111111111' },
      { legalName: 'Good Shop LLC' },
      { contactEmail: 'seller@example.com' },
      { contactPhoneE164: '+201000000000' },
      { verificationStatus: 'verified' },
      { viewCount: 12 },
      { status: 'active' },
      { location: 'POINT(31.2 30.0)' },
      { listingTypeCode: 'service' },
      { createdAt: '2026-01-01T12:00:00.000Z' },
    ]) {
      expect(ServiceSummarySchema.safeParse({ ...SUMMARY, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('carries the price as a string of minor units, never a number', () => {
    expect(ServiceSummarySchema.safeParse({ ...SUMMARY, priceMinor: 150000 }).success).toBe(false);
    expect(ServiceSummarySchema.safeParse({ ...SUMMARY, priceMinor: '1500.00' }).success).toBe(false);
    expect(ServiceSummarySchema.safeParse({ ...SUMMARY, priceMinor: '0' }).success).toBe(true);
  });
});

describe('a service detail', () => {
  it('accepts the approved projection', () => {
    expect(ServiceDetailResponseSchema.safeParse({ service: DETAIL }).success).toBe(true);
  });

  it('carries the service-specific fields, each of them optional', () => {
    const bare = { ...DETAIL, requiresBrief: null, scope: null };
    expect(ServiceDetailResponseSchema.safeParse({ service: bare }).success).toBe(true);
  });

  it('knows exactly two availability values', () => {
    for (const availability of ['available', 'no_longer_available']) {
      expect(ServiceDetailResponseSchema.safeParse({ service: { ...DETAIL, availability } }).success).toBe(true);
    }
    for (const bad of ['sold', 'archived', 'draft', 'expired']) {
      expect(ServiceDetailResponseSchema.safeParse({ service: { ...DETAIL, availability: bad } }).success).toBe(false);
    }
  });

  it('projects a seller as a display name and a slug only', () => {
    const seller = { slug: 'good-shop', displayName: 'Good Shop' };
    expect(ServiceDetailResponseSchema.safeParse({ service: { ...DETAIL, seller } }).success).toBe(true);
    for (const extra of [{ legalName: 'Good Shop LLC' }, { verificationStatus: 'verified' }, { userId: 'x' }]) {
      expect(
        ServiceDetailResponseSchema.safeParse({ service: { ...DETAIL, seller: { ...seller, ...extra } } }).success,
      ).toBe(false);
    }
  });

  it('is a document under `service`, not `listing`', () => {
    expect(ServiceDetailResponseSchema.safeParse({ listing: DETAIL }).success).toBe(false);
  });
});

describe('a page of services', () => {
  it('is a list plus a cursor, and nothing else', () => {
    expect(ServicesResponseSchema.safeParse({ items: [SUMMARY], nextCursor: null }).success).toBe(true);
    expect(ServicesResponseSchema.safeParse({ items: [], nextCursor: 'abc' }).success).toBe(true);
    expect(ServicesResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
    expect(ServicesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('the page-size rule', () => {
  it('mirrors the listing surface', () => {
    expect(SERVICES_DEFAULT_LIMIT).toBe(20);
    expect(SERVICES_MAX_LIMIT).toBe(50);
    expect(parseServicesLimit(undefined)).toEqual({ ok: true, limit: 20 });
    expect(parseServicesLimit('50')).toEqual({ ok: true, limit: 50 });
  });

  it('refuses anything outside it rather than quietly clamping', () => {
    for (const bad of ['0', '-1', '51', '500', '1.5', 'ten', ' 20']) {
      expect(parseServicesLimit(bad).ok, bad).toBe(false);
    }
  });
});

describe('the canonical surface', () => {
  it('names the two public surfaces and nothing else', () => {
    expect(isCanonicalSurface('product')).toBe(true);
    expect(isCanonicalSurface('service')).toBe(true);
    for (const bad of ['listing', 'services', '', null, undefined, 3]) {
      expect(isCanonicalSurface(bad), String(bad)).toBe(false);
    }
  });
});
