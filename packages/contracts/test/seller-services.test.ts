import { describe, expect, it } from 'vitest';
import {
  SELLER_SERVICES_DEFAULT_LIMIT,
  SELLER_SERVICES_MAX_LIMIT,
  SELLER_SERVICE_PRICING_MODELS,
  SERVICE_SCOPE_MAX_LENGTH,
  SellerServiceCreateRequestSchema,
  SellerServiceSchema,
  SellerServiceUpdateRequestSchema,
  SellerServicesResponseSchema,
} from '../src/index.js';
import { generateOpenApiDocument } from '../src/openapi/document.js';

/**
 * The seller service contracts (Phase 6-G).
 *
 * Five properties:
 *
 * **No status, no type, and no way to invent either.** A service is created by an operation that creates only
 * services, so there is no `listingTypeCode` field; and there is no status field anywhere, so submission and
 * archival cannot be reached by an edit. Every object is strict, so sending one is a validation failure
 * rather than a value quietly dropped.
 *
 * **No identifier, in either direction.** Not a listing id, not a category id, not a seller.
 *
 * **The detail limits are `listing_service_details`' own**, restated so a browser is refused before a round
 * trip and never loosened: the two pricing models, the 1–365 delivery window, a non-negative revision count
 * and a 5000-character scope.
 *
 * **Absent, null and a value are three different things**, and for the pricing model `null` is a fourth: it
 * withdraws the detail row. The schemas say which fields may be which.
 *
 * **Money is the repository's.** `priceMinor` is the same decimal-string shape every other contract uses for
 * `listings.price_minor`, and the currency's own minor unit travels with it so nothing has to assume a
 * divisor.
 */

const VALID_CREATE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
};

const VALID_SERVICE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  status: 'draft',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  priceMinor: '9900',
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
  requiresBrief: true,
  scope: 'Two concepts.',
  mediaCount: 0,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

describe('the service vocabulary', () => {
  it('names the two pricing models the detail table allows, and no third', () => {
    expect([...SELLER_SERVICE_PRICING_MODELS]).toEqual(['fixed', 'custom']);
  });

  it('keeps the page sizes and the scope ceiling the database uses', () => {
    expect(SELLER_SERVICES_DEFAULT_LIMIT).toBe(20);
    expect(SELLER_SERVICES_MAX_LIMIT).toBe(50);
    expect(SERVICE_SCOPE_MAX_LENGTH).toBe(5000);
  });
});

describe('the service a seller reads back', () => {
  it('accepts the twenty-three fields and nothing else', () => {
    expect(SellerServiceSchema.safeParse(VALID_SERVICE).success).toBe(true);
    expect(Object.keys(VALID_SERVICE)).toHaveLength(23);
  });

  it.each([
    'id',
    'sellerUserId',
    'listingId',
    'categoryId',
    'listingTypeCode',
    'approvedAt',
    'publishedAt',
    'deletedAt',
    'viewCount',
    'rejectionReason',
    'moderationNote',
    'suspensionReason',
  ])('refuses a %s that the API somehow sent', (field) => {
    expect(SellerServiceSchema.safeParse({ ...VALID_SERVICE, [field]: 'x' }).success).toBe(false);
  });

  it('allows every detail field to be null, because the detail row is optional', () => {
    const bare = {
      ...VALID_SERVICE,
      pricingModel: null,
      deliveryDays: null,
      revisionsIncluded: null,
      requiresBrief: null,
      scope: null,
    };
    expect(SellerServiceSchema.safeParse(bare).success).toBe(true);
  });

  it('carries the price as a decimal string and the currency’s own minor unit beside it', () => {
    const parsed = SellerServiceSchema.parse(VALID_SERVICE);
    expect(parsed.priceMinor).toBe('9900');
    expect(parsed.currencyMinorUnit).toBe(2);
    // A number would lose the top of a bigint, and the repository carries this column as a string
    // everywhere else for exactly that reason.
    expect(SellerServiceSchema.safeParse({ ...VALID_SERVICE, priceMinor: 9900 }).success).toBe(false);
    expect(SellerServiceSchema.safeParse({ ...VALID_SERVICE, priceMinor: '99.00' }).success).toBe(false);
    expect(SellerServiceSchema.safeParse({ ...VALID_SERVICE, priceMinor: null }).success).toBe(true);
  });

  it('keeps the delivery window and the revision floor the detail table declares', () => {
    const at = (over: Record<string, unknown>) =>
      SellerServiceSchema.safeParse({ ...VALID_SERVICE, ...over }).success;
    expect(at({ deliveryDays: 1 })).toBe(true);
    expect(at({ deliveryDays: 365 })).toBe(true);
    expect(at({ deliveryDays: 0 })).toBe(false);
    expect(at({ deliveryDays: 366 })).toBe(false);
    expect(at({ revisionsIncluded: 0 })).toBe(true);
    expect(at({ revisionsIncluded: -1 })).toBe(false);
  });

  it('refuses a pricing model the detail table does not allow', () => {
    expect(SellerServiceSchema.safeParse({ ...VALID_SERVICE, pricingModel: 'hourly' }).success).toBe(false);
  });

  it('carries a page of services and one nullable opaque cursor', () => {
    const page = { services: [VALID_SERVICE], nextCursor: null };
    expect(SellerServicesResponseSchema.safeParse(page).success).toBe(true);
    expect(SellerServicesResponseSchema.safeParse({ ...page, nextCursor: 'abc' }).success).toBe(true);
    expect(SellerServicesResponseSchema.safeParse({ ...page, total: 1 }).success).toBe(false);
    // Not `listings`: this is a different reader with different fields.
    expect(SellerServicesResponseSchema.safeParse({ listings: [], nextCursor: null }).success).toBe(false);
  });
});

describe('creating a service draft', () => {
  it('needs only the listings table’s not-null columns, and no detail row', () => {
    const parsed = SellerServiceCreateRequestSchema.safeParse(VALID_CREATE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pricingModel).toBeUndefined();
    expect(parsed.data.priceMinor).toBeUndefined();
    expect(JSON.stringify(parsed.data)).not.toContain('media');
  });

  it('has no listingTypeCode at all: this operation creates a service and nothing else', () => {
    expect(
      SellerServiceCreateRequestSchema.safeParse({ ...VALID_CREATE, listingTypeCode: 'product' }).success,
    ).toBe(false);
  });

  it.each([
    'status',
    'sellerUserId',
    'userId',
    'id',
    'listingId',
    'categoryId',
    'listingTypeCode',
    'approvedAt',
    'submittedAt',
    'archivedAt',
    'viewCount',
  ])('refuses a request carrying %s rather than dropping it', (field) => {
    expect(
      SellerServiceCreateRequestSchema.safeParse({ ...VALID_CREATE, [field]: 'anything' }).success,
    ).toBe(false);
  });

  it('accepts the five detail fields together', () => {
    const parsed = SellerServiceCreateRequestSchema.safeParse({
      ...VALID_CREATE,
      pricingModel: 'fixed',
      deliveryDays: 7,
      revisionsIncluded: 3,
      requiresBrief: true,
      scope: 'Two concepts.',
    });
    expect(parsed.success).toBe(true);
  });

  it('applies the detail table’s own bounds', () => {
    const at = (over: Record<string, unknown>) =>
      SellerServiceCreateRequestSchema.safeParse({ ...VALID_CREATE, ...over }).success;
    expect(at({ pricingModel: 'custom', deliveryDays: 365 })).toBe(true);
    expect(at({ pricingModel: 'custom', deliveryDays: 366 })).toBe(false);
    expect(at({ pricingModel: 'custom', deliveryDays: 0 })).toBe(false);
    expect(at({ pricingModel: 'custom', revisionsIncluded: -1 })).toBe(false);
    expect(at({ pricingModel: 'custom', scope: 's'.repeat(SERVICE_SCOPE_MAX_LENGTH) })).toBe(true);
    expect(at({ pricingModel: 'custom', scope: 's'.repeat(SERVICE_SCOPE_MAX_LENGTH + 1) })).toBe(false);
    expect(at({ pricingModel: 'hourly' })).toBe(false);
  });

  it('carries the price as a digits-only string, or not at all', () => {
    const at = (price: unknown) =>
      SellerServiceCreateRequestSchema.safeParse({ ...VALID_CREATE, priceMinor: price }).success;
    expect(at('0')).toBe(true);
    expect(at('9900')).toBe(true);
    expect(at(null)).toBe(true);
    expect(at(9900)).toBe(false);
    expect(at('-1')).toBe(false);
    expect(at('99.00')).toBe(false);
  });

  it('reuses the listing slug, title and description rules rather than restating them', () => {
    const at = (over: Record<string, unknown>) =>
      SellerServiceCreateRequestSchema.safeParse({ ...VALID_CREATE, ...over }).success;
    expect(at({ slug: 'Logo-Design' })).toBe(false);
    expect(at({ slug: 'ab' })).toBe(false);
    expect(at({ title: 'ab' })).toBe(false);
    expect(at({ title: 'a'.repeat(141) })).toBe(false);
    expect(at({ description: 'a'.repeat(9) })).toBe(false);
  });
});

describe('editing a service draft', () => {
  it('accepts an edit that changes nothing', () => {
    expect(SellerServiceUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it.each(['priceMinor', 'governorate', 'city', 'deliveryDays', 'scope'])(
    'lets %s be cleared, because its column may be empty',
    (field) => {
      expect(SellerServiceUpdateRequestSchema.safeParse({ [field]: null }).success).toBe(true);
    },
  );

  it('lets the pricing model be withdrawn, which removes the whole detail row', () => {
    expect(SellerServiceUpdateRequestSchema.safeParse({ pricingModel: null }).success).toBe(true);
  });

  it.each(['revisionsIncluded', 'requiresBrief'])(
    'refuses a null %s: the detail table declares it not-null with a default',
    (field) => {
      expect(SellerServiceUpdateRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    },
  );

  it.each(['title', 'description', 'contentLanguage', 'currencyCode', 'countryCode', 'isNegotiable'])(
    'refuses a null %s: it can be changed and never emptied',
    (field) => {
      expect(SellerServiceUpdateRequestSchema.safeParse({ [field]: null }).success).toBe(false);
    },
  );

  it.each(['slug', 'listingTypeCode', 'categorySlug', 'status', 'sellerUserId', 'submittedAt'])(
    'has no %s at all, so an edit cannot become one',
    (field) => {
      expect(SellerServiceUpdateRequestSchema.safeParse({ [field]: 'anything' }).success).toBe(false);
    },
  );

  it('edits the fourteen fields it declares and no more', () => {
    const everything = {
      title: 'Logo Design Pro',
      description: 'A rather different description.',
      priceMinor: '7500',
      isNegotiable: true,
      contentLanguage: 'ar',
      currencyCode: 'EGP',
      countryCode: 'EG',
      governorate: 'Cairo Governorate',
      city: 'Alexandria',
      pricingModel: 'custom' as const,
      deliveryDays: 9,
      revisionsIncluded: 1,
      requiresBrief: false,
      scope: 'Revised scope.',
    };
    expect(SellerServiceUpdateRequestSchema.safeParse(everything).success).toBe(true);
    expect(Object.keys(everything)).toHaveLength(14);
  });
});

describe('the OpenAPI operations', () => {
  const doc = generateOpenApiDocument();

  it('documents three service operations across two paths', () => {
    expect(doc.paths?.['/v1/sellers/me/services']?.get?.operationId).toBe('getV1SellersMeServices');
    expect(doc.paths?.['/v1/sellers/me/services']?.post?.operationId).toBe('postV1SellersMeServices');
    expect(doc.paths?.['/v1/sellers/me/services/{slug}']?.patch?.operationId).toBe(
      'patchV1SellersMeService',
    );
  });

  it('documents no service submission or archive operation: those are the listing ones', () => {
    for (const path of Object.keys(doc.paths ?? {})) {
      expect(path, path).not.toContain('/services/{slug}/submission');
      expect(path, path).not.toContain('/services/{slug}/archive');
    }
    // And the listing ones are still there, because that is where a service is submitted and archived.
    expect(doc.paths?.['/v1/sellers/me/listings/{slug}/submission']?.post).toBeDefined();
    expect(doc.paths?.['/v1/sellers/me/listings/{slug}/archive']?.post).toBeDefined();
  });

  it('answers both writes with the same mutation response the listing writes answer with', () => {
    const body = (path: string, method: 'post' | 'patch'): string =>
      JSON.stringify(
        (doc.paths?.[path]?.[method] as { responses?: Record<string, unknown> } | undefined)?.responses ??
          {},
      );
    expect(body('/v1/sellers/me/services', 'post')).toContain('SellerListingMutationResponse');
    expect(body('/v1/sellers/me/services/{slug}', 'patch')).toContain('SellerListingMutationResponse');
  });

  it('takes no seller parameter anywhere: the account comes from the session', () => {
    for (const path of Object.keys(doc.paths ?? {})) {
      if (!path.startsWith('/v1/sellers/me/services')) continue;
      for (const operation of Object.values(doc.paths?.[path] ?? {})) {
        const parameters = JSON.stringify(
          (operation as { parameters?: unknown }).parameters ?? [],
        ).toLowerCase();
        for (const word of ['selleruserid', 'userid', 'owner', 'status', 'listingtype']) {
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

    expect(responses('/v1/sellers/me/services', 'get')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
      '503',
    ]);
    expect(responses('/v1/sellers/me/services', 'post')).toEqual([
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
    expect(responses('/v1/sellers/me/services/{slug}', 'patch')).toEqual([
      '200',
      '400',
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
      if (!path.startsWith('/v1/sellers/me/services')) continue;
      for (const [method, operation] of Object.entries(doc.paths?.[path] ?? {})) {
        const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
        for (const [status, response] of Object.entries(responses)) {
          if (Number(status) < 400) continue;
          const serialized = JSON.stringify(response);
          expect(serialized, `${path} ${method} ${status}`).toContain('ProblemDetails');
          for (const field of ['reason', 'moderator', 'note', 'sellerUserId']) {
            expect(serialized, `${path} ${method} ${status} ${field}`).not.toContain(`"${field}"`);
          }
        }
      }
    }
  });

  it('adds no problem code of its own: 6-G reuses 6-F’s three conflicts', () => {
    const codes = (doc.components?.schemas?.['ProblemCode'] as { enum?: string[] } | undefined)?.enum ?? [];
    for (const code of codes) {
      expect(code, code).not.toContain('SELLER_SERVICE');
    }
    for (const code of [
      'SELLER_LISTING_NOT_EDITABLE',
      'SELLER_LISTING_SLUG_TAKEN',
      'SELLER_LISTING_INCOMPLETE',
    ]) {
      expect(codes, code).toContain(code);
    }
  });

  it('registers the service components without an identifier among them', () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'SellerService',
      'SellerServicesResponse',
      'SellerServiceCreateRequest',
      'SellerServiceUpdateRequest',
      'SellerServicePricingModel',
    ]) {
      expect(Object.keys(schemas), name).toContain(name);
    }
    const service = JSON.stringify(schemas['SellerService']);
    for (const field of ['sellerUserId', 'categoryId', 'approvedAt', 'viewCount', 'deletedAt', 'listingId']) {
      expect(service, field).not.toContain(field);
    }
  });

  it('leaves the frozen 4-C public service operations exactly as they were', () => {
    expect(doc.paths?.['/v1/services']?.get?.operationId).toBe('getV1Services');
    expect(Object.keys(doc.paths?.['/v1/services'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths?.['/v1/services/{slug}'] ?? {})).toEqual(['get']);
  });
});
