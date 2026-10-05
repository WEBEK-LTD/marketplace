import { describe, expect, it } from 'vitest';
import {
  LISTING_SLUG_PATTERN,
  SELLER_LISTINGS_DEFAULT_LIMIT,
  SELLER_LISTINGS_MAX_LIMIT,
  SELLER_LISTING_STATUSES,
  SELLER_LISTING_TYPES,
  SellerListingCreateRequestSchema,
  SellerListingMutationResponseSchema,
  SellerListingSchema,
  SellerListingUpdateRequestSchema,
  SellerListingsResponseSchema,
} from '../src/index.js';
import { generateOpenApiDocument } from '../src/openapi/document.js';

/**
 * The seller listing contracts (Phase 6-F).
 *
 * The contracts are where most of this increment's security is expressed, so most of this suite is about
 * what a request *cannot* say. Four properties:
 *
 * **No status, and no way to invent one.** No request schema has a status field, so submission and archival
 * cannot be reached by an edit; and because every object is strict, sending one is a validation failure
 * rather than a value that is quietly dropped. The difference matters: an ignored `"status": "active"` looks
 * like success to whoever sent it.
 *
 * **No identifier, in either direction.** Not a listing id, not a category id, not a seller. Everything is
 * addressed by slug, which is already a public vocabulary, so nothing internal travels at all.
 *
 * **The limits are the listings table's own**, restated here so a browser is refused before a round trip and
 * never loosened: the same slug format, the same 3..140 title, the same 10..20000 description.
 *
 * **Absent, null and a value are three different things**, and the schemas say which fields may be which.
 */

const VALID_CREATE = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
};

const VALID_LISTING = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  status: 'draft',
  currencyCode: 'EGP',
  priceMinor: 9900,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  mediaCount: 2,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

describe('the listing statuses a seller may see', () => {
  it('is the listings table’s vocabulary minus deleted', () => {
    expect([...SELLER_LISTING_STATUSES]).toEqual([
      'draft',
      'pending_review',
      'approved',
      'active',
      'sold',
      'expired',
      'archived',
      'rejected',
      'suspended',
    ]);
    // A deleted listing is not listed at all, so no client has to know how to render one.
    expect(SELLER_LISTING_STATUSES).not.toContain('deleted');
  });

  it('names the two listing types the reference table holds, and no third', () => {
    expect([...SELLER_LISTING_TYPES]).toEqual(['product', 'service']);
  });

  it('keeps the listing slug rule separate from the seller slug rule', () => {
    expect(LISTING_SLUG_PATTERN.test('a-chair')).toBe(true);
    expect(LISTING_SLUG_PATTERN.test('ab')).toBe(false);
    expect(LISTING_SLUG_PATTERN.test('A-Chair')).toBe(false);
    expect(LISTING_SLUG_PATTERN.test('-leading')).toBe(false);
    expect(LISTING_SLUG_PATTERN.test('trailing-')).toBe(false);
    // 120 is the listings table's own maximum, and it is not the seller table's 50.
    expect(LISTING_SLUG_PATTERN.test('a'.repeat(120))).toBe(true);
    expect(LISTING_SLUG_PATTERN.test('a'.repeat(121))).toBe(false);
  });

  it('keeps the page sizes the reader clamps to', () => {
    expect(SELLER_LISTINGS_DEFAULT_LIMIT).toBe(20);
    expect(SELLER_LISTINGS_MAX_LIMIT).toBe(50);
  });
});

describe('the listing a seller reads back', () => {
  it('accepts the eighteen fields and nothing else', () => {
    expect(SellerListingSchema.safeParse(VALID_LISTING).success).toBe(true);
    expect(Object.keys(VALID_LISTING)).toHaveLength(18);
  });

  it.each([
    'id',
    'sellerUserId',
    'categoryId',
    'approvedAt',
    'publishedAt',
    'deletedAt',
    'viewCount',
    'rejectionReason',
    'moderationNote',
    'suspensionReason',
  ])('refuses a %s that the API somehow sent', (field) => {
    expect(SellerListingSchema.safeParse({ ...VALID_LISTING, [field]: 'x' }).success).toBe(false);
  });

  it('allows a draft with no price, which is what S-9 requires', () => {
    expect(SellerListingSchema.safeParse({ ...VALID_LISTING, priceMinor: null }).success).toBe(true);
  });

  it('counts media rather than naming them, so no object path can travel', () => {
    const parsed = SellerListingSchema.parse(VALID_LISTING);
    expect(parsed.mediaCount).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain('objectPath');
    expect(SellerListingSchema.safeParse({ ...VALID_LISTING, mediaCount: -1 }).success).toBe(false);
  });

  it('carries a page of listings and one nullable opaque cursor', () => {
    const page = { listings: [VALID_LISTING], nextCursor: null };
    expect(SellerListingsResponseSchema.safeParse(page).success).toBe(true);
    expect(SellerListingsResponseSchema.safeParse({ ...page, nextCursor: 'abc' }).success).toBe(true);
    expect(SellerListingsResponseSchema.safeParse({ ...page, total: 1 }).success).toBe(false);
  });
});

describe('creating a draft', () => {
  it('needs only the listings table’s not-null columns', () => {
    const parsed = SellerListingCreateRequestSchema.safeParse(VALID_CREATE);
    expect(parsed.success).toBe(true);
    // No price, no media, no detail row: a draft is creatable without any of them.
    expect(parsed.success && parsed.data.priceMinor).toBeUndefined();
  });

  it.each([
    'status',
    'sellerUserId',
    'userId',
    'id',
    'listingId',
    'categoryId',
    'approvedAt',
    'submittedAt',
    'archivedAt',
    'publishedAt',
    'deletedAt',
    'viewCount',
    'createdAt',
  ])('refuses a request carrying %s rather than dropping it', (field) => {
    const parsed = SellerListingCreateRequestSchema.safeParse({ ...VALID_CREATE, [field]: 'anything' });
    expect(parsed.success).toBe(false);
  });

  it('applies the listings table’s own title and description bounds', () => {
    const at = (over: Record<string, unknown>) =>
      SellerListingCreateRequestSchema.safeParse({ ...VALID_CREATE, ...over }).success;

    expect(at({ title: 'ab' })).toBe(false);
    expect(at({ title: 'abc' })).toBe(true);
    expect(at({ title: 'a'.repeat(140) })).toBe(true);
    expect(at({ title: 'a'.repeat(141) })).toBe(false);
    // Measured on the trimmed value, as the check constraint measures it.
    expect(at({ title: '   ab   ' })).toBe(false);
    expect(at({ description: 'a'.repeat(9) })).toBe(false);
    expect(at({ description: 'a'.repeat(10) })).toBe(true);
    expect(at({ description: 'a'.repeat(20_000) })).toBe(true);
    expect(at({ description: 'a'.repeat(20_001) })).toBe(false);
  });

  it('refuses a price that is not a whole non-negative number', () => {
    const at = (price: unknown) =>
      SellerListingCreateRequestSchema.safeParse({ ...VALID_CREATE, priceMinor: price }).success;
    expect(at(0)).toBe(true);
    expect(at(-1)).toBe(false);
    expect(at(1.5)).toBe(false);
    expect(at('100')).toBe(false);
    // An explicit null is a draft with no price, which is a different thing from a bad price.
    expect(at(null)).toBe(true);
  });

  it('refuses an unknown listing type', () => {
    expect(
      SellerListingCreateRequestSchema.safeParse({ ...VALID_CREATE, listingTypeCode: 'gizmo' }).success,
    ).toBe(false);
  });
});

describe('editing a draft', () => {
  it('accepts an edit that changes nothing', () => {
    expect(SellerListingUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it.each(['priceMinor', 'governorate', 'city'])(
    'lets %s be cleared, because the listings table allows that column to be empty',
    (field) => {
      expect(SellerListingUpdateRequestSchema.safeParse({ [field]: null }).success).toBe(true);
    },
  );

  it.each(['title', 'description', 'contentLanguage', 'currencyCode', 'countryCode', 'isNegotiable'])(
    'refuses a null %s: it can be changed and never emptied',
    (field) => {
      expect(SellerListingUpdateRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    },
  );

  it.each(['slug', 'listingTypeCode', 'categorySlug', 'status', 'sellerUserId', 'submittedAt'])(
    'has no %s at all, so an edit cannot become one',
    (field) => {
      expect(SellerListingUpdateRequestSchema.safeParse({ [field]: 'anything' }).success).toBe(false);
    },
  );

  it('refuses an empty string where a value is required, so a blank box cannot empty a column', () => {
    expect(SellerListingUpdateRequestSchema.safeParse({ governorate: '' }).success).toBe(false);
    expect(SellerListingUpdateRequestSchema.safeParse({ city: '' }).success).toBe(false);
  });
});

describe('what a write answers with', () => {
  it('is an address and a committed status, and nothing else', () => {
    const body = { listing: { slug: 'a-chair', status: 'pending_review' } };
    expect(SellerListingMutationResponseSchema.safeParse(body).success).toBe(true);
    expect(
      SellerListingMutationResponseSchema.safeParse({
        listing: { slug: 'a-chair', status: 'draft', id: 'x' },
      }).success,
    ).toBe(false);
    expect(
      SellerListingMutationResponseSchema.safeParse({ listing: { slug: 'a-chair', status: 'deleted' } })
        .success,
    ).toBe(false);
  });
});

describe('the OpenAPI operations', () => {
  const doc = generateOpenApiDocument();

  it('documents five listing operations across four paths', () => {
    expect(doc.paths?.['/v1/sellers/me/listings']?.get?.operationId).toBe('getV1SellersMeListings');
    expect(doc.paths?.['/v1/sellers/me/listings']?.post?.operationId).toBe('postV1SellersMeListings');
    expect(doc.paths?.['/v1/sellers/me/listings/{slug}']?.patch?.operationId).toBe(
      'patchV1SellersMeListing',
    );
    expect(doc.paths?.['/v1/sellers/me/listings/{slug}/submission']?.post?.operationId).toBe(
      'postV1SellersMeListingSubmission',
    );
    expect(doc.paths?.['/v1/sellers/me/listings/{slug}/archive']?.post?.operationId).toBe(
      'postV1SellersMeListingArchive',
    );
  });

  it('gives submission and archival no request body at all', () => {
    for (const path of [
      '/v1/sellers/me/listings/{slug}/submission',
      '/v1/sellers/me/listings/{slug}/archive',
    ]) {
      expect(doc.paths?.[path]?.post?.requestBody, path).toBeUndefined();
    }
  });

  it('takes no seller parameter anywhere: the account comes from the session', () => {
    for (const path of Object.keys(doc.paths ?? {})) {
      if (!path.startsWith('/v1/sellers/me/listings')) continue;
      for (const operation of Object.values(doc.paths?.[path] ?? {})) {
        const parameters = JSON.stringify(
          (operation as { parameters?: unknown }).parameters ?? [],
        ).toLowerCase();
        for (const word of ['selleruserid', 'userid', 'owner', 'status']) {
          expect(parameters, `${path} ${word}`).not.toContain(word);
        }
      }
    }
  });

  it('declares the refusals each operation can actually produce', () => {
    const responses = (path: string, method: 'get' | 'post' | 'patch'): string[] =>
      Object.keys(
        (doc.paths?.[path]?.[method] as { responses?: Record<string, unknown> } | undefined)
          ?.responses ?? {},
      ).sort();

    expect(responses('/v1/sellers/me/listings', 'get')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
      '503',
    ]);
    expect(responses('/v1/sellers/me/listings', 'post')).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
      '503',
    ]);
    // No 400 on submission: there is no body to be invalid.
    expect(responses('/v1/sellers/me/listings/{slug}/submission', 'post')).toEqual([
      '200',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
      '503',
    ]);
  });

  it('gives every refusal the shared problem document, so no bespoke error body can carry a reason', () => {
    for (const path of Object.keys(doc.paths ?? {})) {
      if (!path.startsWith('/v1/sellers/me/listings')) continue;
      for (const [method, operation] of Object.entries(doc.paths?.[path] ?? {})) {
        const responses =
          (operation as { responses?: Record<string, unknown> }).responses ?? {};
        for (const [status, response] of Object.entries(responses)) {
          if (Number(status) < 400) continue;
          const body = JSON.stringify(response);
          expect(body, `${path} ${method} ${status}`).toContain('ProblemDetails');
          // The shared document has a code, a title and a detail. Nothing else is declared, so there is
          // no field a moderation reason could arrive in.
          for (const field of ['reason', 'moderator', 'note', 'sellerUserId']) {
            expect(body, `${path} ${method} ${status} ${field}`).not.toContain(`"${field}"`);
          }
        }
      }
    }
  });

  it('registers the listing components without an identifier among them', () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'SellerListing',
      'SellerListingsResponse',
      'SellerListingCreateRequest',
      'SellerListingUpdateRequest',
      'SellerListingMutationResponse',
      'SellerListingRef',
      'SellerListingStatus',
      'SellerListingType',
      'ListingSlug',
    ]) {
      expect(Object.keys(schemas), name).toContain(name);
    }
    const listing = JSON.stringify(schemas['SellerListing']);
    for (const field of ['sellerUserId', 'categoryId', 'approvedAt', 'viewCount', 'deletedAt']) {
      expect(listing, field).not.toContain(field);
    }
  });
});
