import { describe, expect, it } from 'vitest';
import {
  SELLER_AVAILABILITY,
  SELLER_SLUG_PATTERN,
  SELLER_STATUSES,
  SELLER_VERIFICATION_STATUSES,
  SellerBalanceSchema,
  SellerOrderSchema,
  SellerPromotionPerformanceSchema,
  SellerPromotionSchema,
  SellerReviewSchema,
  SellerReviewSummarySchema,
  SellerReviewsResponseSchema,
  SellerEarningsResponseSchema,
  SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES,
  SELLER_VERIFICATION_DOCUMENT_MAX_BYTES,
  SELLER_VERIFICATION_DOCUMENT_STATUSES,
  SELLER_VERIFICATION_DOCUMENT_TYPES,
  SELLER_VERIFICATION_STATES,
  SellerVerificationDocumentRequestSchema,
  SellerVerificationDocumentSchema,
  SellerVerificationResponseSchema,
  SellerVerificationSchema,
  SellerVerificationUploadRequestSchema,
  PublicSellerProfileSchema,
  SellerIdentityResponseSchema,
  SellerIdentitySchema,
  SellerOnboardingRequestSchema,
  SellerOnboardingResponseSchema,
  SellerProfileResponseSchema,
  SELLER_MEDIA_CONTENT_TYPES,
  SELLER_MEDIA_KINDS,
  SELLER_MEDIA_MAX_BYTES,
  SellerMediaAttachRequestSchema,
  SellerMediaAttachResponseSchema,
  SellerMediaUploadRequestSchema,
  SellerMediaUploadResponseSchema,
  SellerProfileUpdateRequestSchema,
  SellerProfileUpdateResponseSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/** The six-field projection 6-A shipped, as a fixture the 6-C blocks below build on. */
function identity(): Record<string, unknown> {
  return {
    slug: 'good-shop',
    displayName: 'Good Shop',
    status: 'pending',
    verificationStatus: 'unverified',
    city: 'Cairo',
    countryCode: 'EG',
  };
}

/**
 * The public seller contract (Phase 4-E).
 *
 * Five fields, and the tests that matter are the refusals: every field the owner excluded, and every
 * shape that would let a seller's private life reach a browser.
 */

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  city: 'Cairo',
} as const;

describe('a public seller profile', () => {
  it('accepts the approved projection', () => {
    expect(PublicSellerProfileSchema.safeParse(SELLER).success).toBe(true);
  });

  it('allows a seller with no bio, no language and no city', () => {
    const bare = { ...SELLER, bio: null, contentLanguage: null, city: null };
    expect(PublicSellerProfileSchema.safeParse(bare).success).toBe(true);
  });

  it('requires the two fields the schema guarantees', () => {
    expect(PublicSellerProfileSchema.safeParse({ ...SELLER, slug: '' }).success).toBe(false);
    expect(PublicSellerProfileSchema.safeParse({ ...SELLER, displayName: '' }).success).toBe(false);
  });

  it('refuses every field the owner excluded', () => {
    for (const extra of [
      { verificationStatus: 'verified' },
      { verifiedAt: '2026-01-01T12:00:00.000Z' },
      { countryCode: 'EG' },
      { governorate: 'Cairo' },
      { createdAt: '2026-01-01T12:00:00.000Z' },
      { legalName: 'Good Shop LLC' },
      { contactEmail: 'good@example.com' },
      { contactPhoneE164: '+201000000001' },
      { userId: '11111111-1111-4111-8111-111111111111' },
      { status: 'active' },
      { suspendedAt: '2026-01-01T12:00:00.000Z' },
      { suspensionReason: 'Repeated policy breaches' },
      { closedAt: '2026-01-01T12:00:00.000Z' },
      { logoObjectPath: 'sellers/logo.png' },
      { bannerObjectPath: 'sellers/banner.png' },
      { ratingAverage: 4.5 },
      { reviewCount: 12 },
      { listingCount: 8 },
    ]) {
      expect(PublicSellerProfileSchema.safeParse({ ...SELLER, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });
});

describe('the seller profile response', () => {
  it('carries the seller and the availability, and nothing else', () => {
    expect(SellerProfileResponseSchema.safeParse({ seller: SELLER, availability: 'available' }).success).toBe(true);
    expect(SellerProfileResponseSchema.safeParse({ seller: SELLER }).success).toBe(false);
    expect(
      SellerProfileResponseSchema.safeParse({ seller: SELLER, availability: 'available', status: 'active' }).success,
    ).toBe(false);
  });

  it('knows exactly two availability values', () => {
    expect(SELLER_AVAILABILITY).toEqual(['available', 'unavailable']);
    for (const availability of SELLER_AVAILABILITY) {
      expect(SellerProfileResponseSchema.safeParse({ seller: SELLER, availability }).success).toBe(true);
    }
    // The internal statuses must not be usable as availability values: they are not the same vocabulary.
    for (const bad of ['active', 'suspended', 'pending', 'closed', 'no_longer_available']) {
      expect(SellerProfileResponseSchema.safeParse({ seller: SELLER, availability: bad }).success, bad).toBe(false);
    }
  });

  it('keeps availability outside the seller: it describes the page, not the person', () => {
    expect(
      PublicSellerProfileSchema.safeParse({ ...SELLER, availability: 'available' }).success,
    ).toBe(false);
  });
});

/**
 * The authenticated seller's own identity (Phase 6-A).
 *
 * Six fields, and the assertions are mostly about the seventh that must never exist. The public profile
 * contract is asserted unchanged beside it, because these two are different answers to different questions
 * and the day they merge is the day a guest learns an account's state.
 */
describe('the seller identity', () => {
  const identity = {
    slug: 'good-shop',
    displayName: 'Good Shop',
    status: 'active',
    verificationStatus: 'verified',
    city: 'Cairo',
    countryCode: 'EG',
  };

  it('accepts exactly the six approved fields', () => {
    expect(SellerIdentitySchema.safeParse(identity).success).toBe(true);
    expect(Object.keys(SellerIdentitySchema.shape).sort()).toEqual([
      'city',
      'countryCode',
      'displayName',
      'slug',
      'status',
      'verificationStatus',
    ]);
  });

  it('refuses a seller identifier, contact detail, suspension reason or object path', () => {
    for (const extra of [
      { userId: '11111111-1111-4111-8111-111111111111' },
      { id: '11111111-1111-4111-8111-111111111111' },
      { sellerUserId: '11111111-1111-4111-8111-111111111111' },
      { legalName: 'Good Shop Trading LLC' },
      { contactEmail: 'private@seller.invalid' },
      { contactPhoneE164: '+201555000999' },
      { suspensionReason: 'Repeated policy breaches' },
      { logoObjectPath: 'logos/good-shop.webp' },
      { bannerObjectPath: 'banners/good-shop.webp' },
      { bio: 'We restore mid-century furniture.' },
      { governorate: 'Cairo Governorate' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { verifiedAt: '2026-02-01T00:00:00.000Z' },
      { suspendedAt: null },
      { closedAt: null },
      { availability: 'available' },
    ]) {
      expect(
        SellerIdentitySchema.safeParse({ ...identity, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('knows all four seller statuses and refuses any other', () => {
    expect([...SELLER_STATUSES]).toEqual(['pending', 'active', 'suspended', 'closed']);
    for (const status of SELLER_STATUSES) {
      expect(SellerIdentitySchema.safeParse({ ...identity, status }).success, status).toBe(true);
    }
    for (const status of ['banned', 'deleted', 'draft', 'Active', '']) {
      expect(SellerIdentitySchema.safeParse({ ...identity, status }).success, status).toBe(false);
    }
  });

  it('knows all four verification statuses and refuses any other', () => {
    expect([...SELLER_VERIFICATION_STATUSES]).toEqual([
      'unverified',
      'pending',
      'verified',
      'rejected',
    ]);
    for (const verificationStatus of SELLER_VERIFICATION_STATUSES) {
      expect(
        SellerIdentitySchema.safeParse({ ...identity, verificationStatus }).success,
        verificationStatus,
      ).toBe(true);
    }
    for (const verificationStatus of ['in_review', 'approved', '']) {
      expect(
        SellerIdentitySchema.safeParse({ ...identity, verificationStatus }).success,
        verificationStatus,
      ).toBe(false);
    }
  });

  it('keeps the two states separate: they answer different questions', () => {
    // A suspended seller can be verified, and a pending one can be rejected. Neither implies the other.
    expect(
      SellerIdentitySchema.safeParse({ ...identity, status: 'suspended', verificationStatus: 'verified' })
        .success,
    ).toBe(true);
    expect(
      SellerIdentitySchema.safeParse({ ...identity, status: 'pending', verificationStatus: 'rejected' })
        .success,
    ).toBe(true);
  });

  it('allows a null city and requires a two-letter country', () => {
    expect(SellerIdentitySchema.safeParse({ ...identity, city: null }).success).toBe(true);
    for (const countryCode of ['EGY', 'E', '', null]) {
      expect(
        SellerIdentitySchema.safeParse({ ...identity, countryCode }).success,
        String(countryCode),
      ).toBe(false);
    }
  });

  it('requires a slug and a display name', () => {
    expect(SellerIdentitySchema.safeParse({ ...identity, slug: '' }).success).toBe(false);
    expect(SellerIdentitySchema.safeParse({ ...identity, displayName: '' }).success).toBe(false);
  });

  it('wraps it in a response with one key', () => {
    expect(SellerIdentityResponseSchema.safeParse({ seller: identity }).success).toBe(true);
    expect(SellerIdentityResponseSchema.safeParse({ seller: identity, availability: 'available' }).success).toBe(
      false,
    );
    expect(SellerIdentityResponseSchema.safeParse({}).success).toBe(false);
  });

  it('is not the public profile, and the public profile is unchanged', () => {
    // The public contract keeps its five 4-E fields, and neither shape satisfies the other.
    expect(Object.keys(PublicSellerProfileSchema.shape).sort()).toEqual([
      'bio',
      'city',
      'contentLanguage',
      'displayName',
      'slug',
    ]);
    expect(PublicSellerProfileSchema.safeParse(identity).success).toBe(false);
    expect(
      SellerIdentitySchema.safeParse({
        slug: 'good-shop',
        displayName: 'Good Shop',
        bio: null,
        contentLanguage: null,
        city: 'Cairo',
      }).success,
    ).toBe(false);
  });
});

describe('the seller identity operation', () => {
  const doc = generateOpenApiDocument();

  // Narrowed in 6-C (the creation) and again in 6-D (the edit), both on the same path. The read is unchanged;
  // the assertion names the whole surface of that path, so an unapproved method still fails here.
  it('is documented as one read, one creation and one edit', () => {
    expect(Object.keys(doc.paths?.['/v1/sellers/me'] ?? {}).sort()).toEqual(['get', 'patch', 'post']);
    expect(doc.paths?.['/v1/sellers/me']?.get?.operationId).toBe('getV1SellersMe');
    expect(doc.paths?.['/v1/sellers/me']?.post?.operationId).toBe('postV1SellersMe');
    expect(doc.paths?.['/v1/sellers/me']?.patch?.operationId).toBe('patchV1SellersMe');
  });

  it('documents the session header and the three refusals', () => {
    const responses = doc.paths?.['/v1/sellers/me']?.get?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['200', '401', '403', '404', '500', '503']);
    // No path or query parameter at all — the only header is the session — so there is nothing in the
    // documented request through which a caller could name a seller.
    const operation = doc.paths?.['/v1/sellers/me']?.get;
    expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('slug');
    expect(operation?.requestBody).toBeUndefined();
  });

  it('leaves the public seller operation exactly as 4-E documented it', () => {
    expect(doc.paths?.['/v1/sellers/{slug}']?.get?.operationId).toBe('getV1SellerBySlug');
    expect(Object.keys(doc.paths?.['/v1/sellers/{slug}'] ?? {})).toEqual(['get']);
  });

  // Narrowed in 6-D (the edit), again in 6-E (the two media POSTs), again in 6-F, which adds the listings
  // index and creation on one path, the draft edit on another and the two write-only sub-resources, and again
  // in 6-G, which adds a services index and creation on one path and a draft edit on another — and *no*
  // submission or archive path, because those transitions belong to the listing routes. Narrowed again in
  // 6-I, which adds the verification attempt's own address, its two document POSTs, its submission, and the
  // one DELETE named below.
  //
  // **No PUT anywhere under /v1/sellers** still holds in full: nothing replaces a storefront, a listing or a
  // verification attempt wholesale. The DELETE half is narrowed by exactly one address — removing a
  // verification document the seller themselves uploaded, while their attempt is still theirs to change.
  // Nothing else is deletable: not a storefront, not a listing (a seller archives, which is a POST to its own
  // sub-resource) and not a verification attempt, which a seller cannot withdraw at all.
  const VERIFICATION_DOCUMENT_PATH = '/v1/sellers/me/verification/documents/{documentId}';

  it('adds no seller replace operation, and exactly one deletable resource', () => {
    const allowedFor = (path: string): string[] => {
      if (path === '/v1/sellers/me') return ['get', 'patch', 'post'];
      if (path === '/v1/sellers/me/media' || path === '/v1/sellers/me/media/uploads') return ['post'];
      if (path === '/v1/sellers/me/listings') return ['get', 'post'];
      if (path === '/v1/sellers/me/listings/{slug}') return ['patch'];
      if (
        path === '/v1/sellers/me/listings/{slug}/submission' ||
        path === '/v1/sellers/me/listings/{slug}/archive'
      ) {
        return ['post'];
      }
      if (path === '/v1/sellers/me/services') return ['get', 'post'];
      if (path === '/v1/sellers/me/services/{slug}') return ['patch'];
      // Phase 6-I. Reading the attempt and starting one share an address; the documents have their own.
      if (path === '/v1/sellers/me/verification') return ['get', 'post'];
      if (
        path === '/v1/sellers/me/verification/documents' ||
        path === '/v1/sellers/me/verification/documents/uploads' ||
        path === '/v1/sellers/me/verification/submission'
      ) {
        return ['post'];
      }
      if (path === VERIFICATION_DOCUMENT_PATH) return ['delete'];
      // Phase 8-C. The attributes and the tags of one of the caller's own listings or services: reading the
      // questions and answering them share an address, and the answer is a POST rather than a PUT because
      // nothing under /v1/sellers replaces a resource wholesale.
      if (
        path === '/v1/sellers/me/listings/{slug}/attributes' ||
        path === '/v1/sellers/me/listings/{slug}/tags' ||
        path === '/v1/sellers/me/services/{slug}/attributes' ||
        path === '/v1/sellers/me/services/{slug}/tags'
      ) {
        return ['get', 'post'];
      }
      return ['get'];
    };
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      if (!path.startsWith('/v1/sellers')) continue;
      expect(Object.keys(methods as object).sort(), path).toEqual(allowedFor(path));
      // PUT is prohibited everywhere: nothing under /v1/sellers replaces a resource wholesale. DELETE is
      // prohibited everywhere but the single 6-I address below, which removes one verification document the
      // seller uploaded — never a storefront, a listing or a verification attempt.
      expect(Object.keys(methods as object), `${path} put`).not.toContain('put');
      if (path !== VERIFICATION_DOCUMENT_PATH) {
        expect(Object.keys(methods as object), `${path} delete`).not.toContain('delete');
      }
    }
    // Under /v1/sellers the one permitted DELETE is that address and no other. (Elsewhere in the document
    // 5-E's conversation membership is also a DELETE; that is a frozen messaging route and none of this
    // surface's business.)
    expect(
      Object.entries(doc.paths ?? {})
        .filter(([path]) => path.startsWith('/v1/sellers'))
        .filter(([, methods]) => Object.keys(methods as object).includes('delete'))
        .map(([path]) => path),
    ).toEqual([VERIFICATION_DOCUMENT_PATH]);
    // And the public seller route is still a read and only a read.
    expect(Object.keys(doc.paths?.['/v1/sellers/{slug}'] ?? {})).toEqual(['get']);
  });
});

describe('the seller onboarding operation', () => {
  const doc = generateOpenApiDocument();
  const operation = doc.paths?.['/v1/sellers/me']?.post;

  it('is one authenticated creation answering 201', () => {
    expect(operation?.operationId).toBe('postV1SellersMe');
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '429',
      '500',
      '503',
    ]);
  });

  it('takes a body and no parameter through which a seller could be named', () => {
    expect(operation?.requestBody).toBeDefined();
    expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('slug');
    expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('userId');
  });

  it('documents the request as the strict onboarding schema and the response as the identity projection', () => {
    expect(JSON.stringify(operation?.requestBody)).toContain('SellerOnboardingRequest');
    expect(JSON.stringify(operation?.responses?.['201'])).toContain('SellerOnboardingResponse');
  });

  it('leaves the 6-A response contract untouched', () => {
    expect(JSON.stringify(doc.paths?.['/v1/sellers/me']?.get?.responses?.['200'])).toContain(
      'SellerIdentityResponse',
    );
    expect(SellerIdentityResponseSchema.safeParse({ seller: identity() }).success).toBe(true);
  });

  it('documents a request schema with no owner, state or private field in it', () => {
    const schema = JSON.stringify(doc.components?.schemas?.['SellerOnboardingRequest'] ?? {});
    for (const absent of [
      'userId',
      'status',
      'verificationStatus',
      'suspensionReason',
      'suspendedAt',
      'closedAt',
      'verifiedAt',
      'createdAt',
      'updatedAt',
      'logoObjectPath',
      'bannerObjectPath',
      'role',
    ]) {
      expect(schema, absent).not.toContain(absent);
    }
  });
});

describe('the seller onboarding request schema', () => {
  const valid = {
    slug: 'good-shop',
    displayName: 'Good Shop',
    countryCode: 'EG',
  };

  it('accepts the three required fields alone', () => {
    expect(SellerOnboardingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts all ten', () => {
    const parsed = SellerOnboardingRequestSchema.safeParse({
      ...valid,
      legalName: 'Good Shop Trading LLC',
      bio: 'We restore mid-century furniture.',
      contentLanguage: 'en',
      governorate: 'Cairo Governorate',
      city: 'Cairo',
      contactEmail: 'owner@example.invalid',
      contactPhone: '+201555000001',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['userId', '11111111-1111-4111-8111-111111111111'],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['role', 'seller'],
    ['id', '1'],
  ])('refuses an injected %s rather than stripping it', (field, value) => {
    // Strict, deliberately: a silently dropped `"status": "active"` looks like success to whoever sent it.
    expect(SellerOnboardingRequestSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it.each([
    ['an uppercase slug', { slug: 'Good-Shop' }],
    ['an underscore', { slug: 'good_shop' }],
    ['two characters', { slug: 'ab' }],
    ['fifty-one characters', { slug: 'a'.repeat(51) }],
    ['a leading hyphen', { slug: '-good' }],
    ['a trailing hyphen', { slug: 'good-' }],
  ])('refuses a slug with %s, matching the database pattern exactly', (_name, override) => {
    expect(SellerOnboardingRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('accepts a three-character and a fifty-character slug', () => {
    expect(SellerOnboardingRequestSchema.safeParse({ ...valid, slug: 'abc' }).success).toBe(true);
    expect(
      SellerOnboardingRequestSchema.safeParse({ ...valid, slug: `${'a'.repeat(49)}b` }).success,
    ).toBe(true);
  });

  it('holds the database limits on the other fields, on both sides', () => {
    const cases: readonly [Record<string, unknown>, boolean][] = [
      [{ displayName: 'A' }, false],
      [{ displayName: 'Ab' }, true],
      [{ displayName: 'n'.repeat(80) }, true],
      [{ displayName: 'n'.repeat(81) }, false],
      [{ bio: 'b'.repeat(2000) }, true],
      [{ bio: 'b'.repeat(2001) }, false],
      [{ countryCode: 'E' }, false],
      [{ countryCode: 'EGY' }, false],
      [{ contactPhone: '+201555000001' }, true],
      [{ contactPhone: '0201555000001' }, false],
      [{ contactPhone: '+0201555000001' }, false],
      [{ contactEmail: 'owner@example.invalid' }, true],
      [{ contactEmail: 'not-an-email' }, false],
      [{ contactEmail: `${'e'.repeat(310)}@example.invalid` }, false],
    ];
    for (const [override, expected] of cases) {
      expect(
        SellerOnboardingRequestSchema.safeParse({ ...valid, ...override }).success,
        JSON.stringify(override),
      ).toBe(expected);
    }
  });

  it('trims the display name, because the database checks the trimmed value', () => {
    const parsed = SellerOnboardingRequestSchema.safeParse({ ...valid, displayName: '  Good Shop  ' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.displayName).toBe('Good Shop');
  });

  it('accepts an absent optional field and refuses an empty one', () => {
    expect(SellerOnboardingRequestSchema.safeParse({ ...valid, legalName: null }).success).toBe(true);
    expect(SellerOnboardingRequestSchema.safeParse({ ...valid, legalName: '   ' }).success).toBe(false);
  });

  it('shares the slug pattern with the database rather than restating it', () => {
    expect(SELLER_SLUG_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$');
  });
});

describe('the seller onboarding response schema', () => {
  it('is the 6-A projection and refuses a seventh field', () => {
    const seller = identity();
    expect(SellerOnboardingResponseSchema.safeParse({ seller }).success).toBe(true);
    expect(
      SellerOnboardingResponseSchema.safeParse({
        seller: { ...seller, userId: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(false);
  });

  it('refuses a status outside the approved vocabulary', () => {
    expect(
      SellerOnboardingResponseSchema.safeParse({ seller: { ...identity(), status: 'brand-new' } }).success,
    ).toBe(false);
  });
});

describe('the seller profile update operation', () => {
  const doc = generateOpenApiDocument();
  const operation = doc.paths?.['/v1/sellers/me']?.patch;

  it('is one authenticated PATCH answering 200', () => {
    expect(operation?.operationId).toBe('patchV1SellersMe');
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
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

  it('takes a body and no parameter through which a seller could be named', () => {
    expect(operation?.requestBody).toBeDefined();
    expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('slug');
    expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('userId');
  });

  it('documents the strict update schema and the identity projection', () => {
    expect(JSON.stringify(operation?.requestBody)).toContain('SellerProfileUpdateRequest');
    expect(JSON.stringify(operation?.responses?.['200'])).toContain('SellerProfileUpdateResponse');
  });

  it('documents a request schema with no slug, owner, state or private field in it', () => {
    const schema = JSON.stringify(doc.components?.schemas?.['SellerProfileUpdateRequest'] ?? {});
    for (const absent of [
      'slug',
      'userId',
      'status',
      'verificationStatus',
      'suspensionReason',
      'suspendedAt',
      'closedAt',
      'verifiedAt',
      'createdAt',
      'updatedAt',
      'logoObjectPath',
      'bannerObjectPath',
      'role',
    ]) {
      expect(schema, absent).not.toContain(absent);
    }
  });

  it('leaves the 6-A read and the 6-C creation exactly as they were', () => {
    expect(JSON.stringify(doc.paths?.['/v1/sellers/me']?.get?.responses?.['200'])).toContain(
      'SellerIdentityResponse',
    );
    expect(JSON.stringify(doc.paths?.['/v1/sellers/me']?.post?.responses?.['201'])).toContain(
      'SellerOnboardingResponse',
    );
  });
});

describe('the seller profile update request schema', () => {
  it('accepts an empty edit: changing nothing is a valid request', () => {
    expect(SellerProfileUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts all nine editable fields at once', () => {
    const parsed = SellerProfileUpdateRequestSchema.safeParse({
      displayName: 'Renamed Shop',
      legalName: 'Renamed Holdings LLC',
      bio: 'We now restore bicycles.',
      contentLanguage: 'ar',
      countryCode: 'EG',
      governorate: 'Alexandria Governorate',
      city: 'Alexandria',
      contactEmail: 'new@example.invalid',
      contactPhone: '+201555009999',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['slug', 'a-different-address'],
    ['userId', '11111111-1111-4111-8111-111111111111'],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['suspendedAt', '2026-01-01T00:00:00.000Z'],
    ['closedAt', '2026-01-01T00:00:00.000Z'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['updatedAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['role', 'seller'],
    ['id', '1'],
  ])('refuses an injected %s rather than stripping it', (field, value) => {
    expect(SellerProfileUpdateRequestSchema.safeParse({ [field]: value }).success).toBe(false);
  });

  it('keeps absent and null as different requests', () => {
    const absent = SellerProfileUpdateRequestSchema.safeParse({ displayName: 'Renamed Shop' });
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    // The key is not merely undefined: it is not there, which is what the API reads as "leave it alone".
    expect(Object.hasOwn(absent.data, 'legalName')).toBe(false);

    const cleared = SellerProfileUpdateRequestSchema.safeParse({ legalName: null });
    expect(cleared.success).toBe(true);
    if (!cleared.success) return;
    expect(Object.hasOwn(cleared.data, 'legalName')).toBe(true);
    expect(cleared.data.legalName).toBeNull();
  });

  it('allows the seven nullable columns to be cleared', () => {
    for (const field of [
      'legalName',
      'bio',
      'contentLanguage',
      'governorate',
      'city',
      'contactEmail',
      'contactPhone',
    ]) {
      expect(SellerProfileUpdateRequestSchema.safeParse({ [field]: null }).success, field).toBe(true);
    }
  });

  it('refuses clearing the two the table declares not null', () => {
    expect(SellerProfileUpdateRequestSchema.safeParse({ displayName: null }).success).toBe(false);
    expect(SellerProfileUpdateRequestSchema.safeParse({ countryCode: null }).success).toBe(false);
  });

  it('refuses an empty string, because a blank box is said with null', () => {
    for (const field of ['legalName', 'bio', 'governorate', 'city']) {
      expect(SellerProfileUpdateRequestSchema.safeParse({ [field]: '' }).success, field).toBe(false);
    }
    expect(SellerProfileUpdateRequestSchema.safeParse({ displayName: '' }).success).toBe(false);
  });

  it('holds the same 0009 limits the onboarding schema holds, on both sides', () => {
    const cases: readonly [Record<string, unknown>, boolean][] = [
      [{ displayName: 'A' }, false],
      [{ displayName: 'Ab' }, true],
      [{ displayName: 'n'.repeat(80) }, true],
      [{ displayName: 'n'.repeat(81) }, false],
      [{ bio: 'b'.repeat(2000) }, true],
      [{ bio: 'b'.repeat(2001) }, false],
      [{ countryCode: 'EG' }, true],
      [{ countryCode: 'E' }, false],
      [{ countryCode: 'EGY' }, false],
      [{ contactPhone: '+201555000001' }, true],
      [{ contactPhone: '0201555000001' }, false],
      [{ contactEmail: 'owner@example.invalid' }, true],
      [{ contactEmail: 'not-an-email' }, false],
      [{ contactEmail: `${'e'.repeat(310)}@example.invalid` }, false],
    ];
    for (const [body, expected] of cases) {
      expect(SellerProfileUpdateRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(expected);
    }
  });

  it('trims what it accepts', () => {
    const parsed = SellerProfileUpdateRequestSchema.safeParse({ displayName: '  Renamed Shop  ' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.displayName).toBe('Renamed Shop');
  });
});

describe('the seller profile update response schema', () => {
  it('is the 6-A projection and refuses a seventh field', () => {
    const seller = identity();
    expect(SellerProfileUpdateResponseSchema.safeParse({ seller }).success).toBe(true);
    expect(
      SellerProfileUpdateResponseSchema.safeParse({
        seller: { ...seller, userId: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(false);
  });

  it('refuses a status outside the approved vocabulary', () => {
    expect(
      SellerProfileUpdateResponseSchema.safeParse({ seller: { ...identity(), status: 'brand-new' } }).success,
    ).toBe(false);
  });
});

describe('the seller media operations', () => {
  const doc = generateOpenApiDocument();
  const authorize = doc.paths?.['/v1/sellers/me/media/uploads']?.post;
  const confirm = doc.paths?.['/v1/sellers/me/media']?.post;

  it('are exactly two POSTs, on their own paths', () => {
    expect(Object.keys(doc.paths?.['/v1/sellers/me/media/uploads'] ?? {})).toEqual(['post']);
    expect(Object.keys(doc.paths?.['/v1/sellers/me/media'] ?? {})).toEqual(['post']);
    expect(authorize?.operationId).toBe('postV1SellersMeMediaUploads');
    expect(confirm?.operationId).toBe('postV1SellersMeMedia');
  });

  it('answer 201 and 200 respectively, with the approved refusals', () => {
    expect(Object.keys(authorize?.responses ?? {}).sort()).toEqual([
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
    expect(Object.keys(confirm?.responses ?? {}).sort()).toEqual([
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

  it('take a body and no parameter through which a seller or a path could be named', () => {
    for (const operation of [authorize, confirm]) {
      expect(operation?.requestBody).toBeDefined();
      const parameters = JSON.stringify(operation?.parameters ?? []);
      expect(parameters).not.toContain('slug');
      expect(parameters).not.toContain('userId');
      expect(parameters).not.toContain('objectPath');
    }
  });

  it('document an authorization request that cannot name a destination', () => {
    const schema = JSON.stringify(doc.components?.schemas?.['SellerMediaUploadRequest'] ?? {});
    for (const absent of ['objectPath', 'bucket', 'slug', 'fileName', 'userId', 'path', 'status']) {
      expect(schema, absent).not.toContain(absent);
    }
  });

  it('document a confirmation response that carries no path', () => {
    const schema = JSON.stringify(doc.components?.schemas?.['SellerMediaState'] ?? {});
    expect(schema).not.toContain('objectPath');
    expect(schema).toContain('hasLogo');
    expect(schema).toContain('hasBanner');
  });

  it('leave every earlier seller operation exactly as it was', () => {
    expect(Object.keys(doc.paths?.['/v1/sellers/me'] ?? {}).sort()).toEqual(['get', 'patch', 'post']);
    expect(Object.keys(doc.paths?.['/v1/sellers/{slug}'] ?? {})).toEqual(['get']);
  });
});

describe('the seller media request schemas', () => {
  const valid = { mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 };

  it('names the two media kinds a storefront has', () => {
    expect([...SELLER_MEDIA_KINDS]).toEqual(['logo', 'banner']);
  });

  it('names the four image types the bucket allows, and no SVG', () => {
    expect([...SELLER_MEDIA_CONTENT_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
    expect(SELLER_MEDIA_CONTENT_TYPES as readonly string[]).not.toContain('image/svg+xml');
  });

  it('carries the bucket ceiling', () => {
    expect(SELLER_MEDIA_MAX_BYTES).toBe(5_242_880);
  });

  it('accepts a well-formed authorization', () => {
    expect(SellerMediaUploadRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['objectPath', 'seller-media/good-shop/logo/x.webp'],
    ['bucket', 'seller-media'],
    ['bucketId', 'seller-media'],
    ['slug', 'good-shop'],
    ['fileName', 'logo.webp'],
    ['path', 'anything'],
    ['userId', '11111111-1111-4111-8111-111111111111'],
    ['status', 'active'],
    ['id', '1'],
  ])('refuses an authorization carrying %s', (field, value) => {
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it.each(['image/svg+xml', 'application/pdf', 'text/html', 'image/gif', 'IMAGE/WEBP', ''])(
    'refuses the content type %s',
    (contentType) => {
      expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, contentType }).success).toBe(false);
    },
  );

  it.each(['avatar', 'document', 'video', 'LOGO', ''])('refuses the media kind %s', (mediaKind) => {
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, mediaKind }).success).toBe(false);
  });

  it('holds the size ceiling on both sides', () => {
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, byteSize: 5_242_880 }).success).toBe(true);
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, byteSize: 5_242_881 }).success).toBe(false);
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, byteSize: 0 }).success).toBe(false);
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, byteSize: -1 }).success).toBe(false);
    expect(SellerMediaUploadRequestSchema.safeParse({ ...valid, byteSize: 1.5 }).success).toBe(false);
  });

  it('accepts a confirmation of a kind and a path, and refuses anything beside them', () => {
    const path = 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp';
    expect(SellerMediaAttachRequestSchema.safeParse({ mediaKind: 'logo', objectPath: path }).success).toBe(true);
    expect(SellerMediaAttachRequestSchema.safeParse({ mediaKind: 'logo' }).success).toBe(false);
    expect(SellerMediaAttachRequestSchema.safeParse({ objectPath: path }).success).toBe(false);
    expect(SellerMediaAttachRequestSchema.safeParse({ mediaKind: 'logo', objectPath: '' }).success).toBe(false);
    expect(
      SellerMediaAttachRequestSchema.safeParse({ mediaKind: 'logo', objectPath: path, bucket: 'x' }).success,
    ).toBe(false);
  });
});

describe('the seller media response schemas', () => {
  const upload = {
    mediaKind: 'logo',
    uploadUrl: 'https://provider.invalid/storage/v1/object/upload/sign/seller-media/x?token=t',
    objectPath: 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp',
    expiresAt: '2026-09-25T22:00:00.000Z',
    maxByteSize: 5_242_880,
  };

  it('accepts an authorization response and refuses a sixth field', () => {
    expect(SellerMediaUploadResponseSchema.safeParse({ upload }).success).toBe(true);
    expect(
      SellerMediaUploadResponseSchema.safeParse({
        upload: { ...upload, userId: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(false);
  });

  it('requires the upload URL to be a URL', () => {
    expect(SellerMediaUploadResponseSchema.safeParse({ upload: { ...upload, uploadUrl: 'nope' } }).success).toBe(
      false,
    );
  });

  it('accepts a confirmation response of two booleans, and nothing else', () => {
    expect(SellerMediaAttachResponseSchema.safeParse({ media: { hasLogo: true, hasBanner: false } }).success).toBe(
      true,
    );
    expect(SellerMediaAttachResponseSchema.safeParse({ media: { hasLogo: true } }).success).toBe(false);
    expect(
      SellerMediaAttachResponseSchema.safeParse({
        media: { hasLogo: true, hasBanner: false, logoPath: 'seller-media/x' },
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------------------- *
 * Phase 6-I — the seller's own verification submission
 *
 * These tests exist to hold the contract to one promise: **a seller submits, and nobody else's authority
 * leaks into the shape**. So they check absences as carefully as presences — no status a client may send, no
 * reviewer field in either direction, no object path in any readback, and no copy or code for a decision.
 * -------------------------------------------------------------------------------------------------------- */
/** The slice of a generated operation these assertions read. Narrow on purpose: no `any` anywhere. */
interface DocumentedResponse {
  readonly content?: Record<string, { readonly schema?: unknown }>;
}
interface DocumentedOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly requestBody?: unknown;
  readonly responses?: Record<string, DocumentedResponse>;
}

describe('the seller verification contracts', () => {
  const doc = generateOpenApiDocument();

  it('takes the document types and statuses from the verification schema, and invents none', () => {
    expect(SELLER_VERIFICATION_DOCUMENT_TYPES).toEqual([
      'national_id',
      'passport',
      'commercial_register',
      'tax_card',
      'bank_statement',
      'other',
    ]);
    expect(SELLER_VERIFICATION_DOCUMENT_STATUSES).toEqual(['pending', 'accepted', 'rejected']);
    expect(SELLER_VERIFICATION_STATES).toEqual([
      'draft',
      'submitted',
      'under_review',
      'approved',
      'rejected',
      'expired',
    ]);
  });

  it('restates the bucket’s own limits and widens neither', () => {
    // 0012's three types: two images and PDF. No SVG, because an SVG is a script container, and no office
    // format, because the bucket allows none.
    expect(SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'application/pdf',
    ]);
    expect(SELLER_VERIFICATION_DOCUMENT_MAX_BYTES).toBe(20_971_520);
    expect(
      SellerVerificationUploadRequestSchema.safeParse({
        documentType: 'passport',
        contentType: 'image/webp',
        byteSize: 10,
      }).success,
    ).toBe(false);
    expect(
      SellerVerificationUploadRequestSchema.safeParse({
        documentType: 'passport',
        contentType: 'application/pdf',
        byteSize: SELLER_VERIFICATION_DOCUMENT_MAX_BYTES,
      }).success,
    ).toBe(true);
    expect(
      SellerVerificationUploadRequestSchema.safeParse({
        documentType: 'passport',
        contentType: 'application/pdf',
        byteSize: SELLER_VERIFICATION_DOCUMENT_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      SellerVerificationUploadRequestSchema.safeParse({
        documentType: 'drivers_licence',
        contentType: 'application/pdf',
        byteSize: 10,
      }).success,
    ).toBe(false);
  });

  it('accepts no status, no reviewer field and no seller from any request', () => {
    const forbidden = [
      'status',
      'verificationStatus',
      'reviewedAt',
      'reviewedBy',
      'reviewerId',
      'decisionReason',
      'reviewNote',
      'sellerUserId',
      'verificationId',
      'expiresAt',
      'submittedAt',
      'emailVerifiedAt',
      'phoneVerifiedAt',
    ];
    const requests = {
      upload: SellerVerificationUploadRequestSchema,
      document: SellerVerificationDocumentRequestSchema,
    };
    for (const [name, schema] of Object.entries(requests)) {
      const valid =
        name === 'upload'
          ? { documentType: 'passport', contentType: 'application/pdf', byteSize: 10 }
          : {
              documentType: 'passport',
              objectPath: 'verification-documents/shop/passport/x.pdf',
              originalFilename: 'p.pdf',
              contentType: 'application/pdf',
              byteSize: 10,
            };
      expect(schema.safeParse(valid).success, name).toBe(true);
      for (const field of forbidden) {
        // Strict schemas, so an unknown key is a validation failure rather than a value quietly ignored:
        // a seller cannot smuggle a decision past this boundary even by naming it correctly.
        expect(schema.safeParse({ ...valid, [field]: 'x' }).success, `${name}.${field}`).toBe(false);
      }
    }
  });

  it('returns a document’s own state but never a reviewer’s words or a path', () => {
    const document = {
      id: '11111111-1111-4111-8111-111111111111',
      documentType: 'national_id',
      originalFilename: 'id.pdf',
      contentType: 'application/pdf',
      byteSize: '4096',
      status: 'rejected',
      uploadedAt: '2026-05-01T00:00:00.000Z',
    };
    expect(SellerVerificationDocumentSchema.safeParse(document).success).toBe(true);
    // A bigint travels as a decimal string, and not as a number.
    expect(SellerVerificationDocumentSchema.safeParse({ ...document, byteSize: 4096 }).success).toBe(
      false,
    );
    for (const field of ['objectPath', 'reviewNote', 'reviewedBy', 'reviewedAt', 'verificationId']) {
      expect(
        SellerVerificationDocumentSchema.safeParse({ ...document, [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });

  it('returns the attempt with no identifier, no reviewer and no decision reason', () => {
    const verification = {
      status: 'submitted',
      submittedAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      emailVerified: true,
      phoneVerified: false,
      documentCount: 0,
      documents: [],
    };
    expect(SellerVerificationSchema.safeParse(verification).success).toBe(true);
    // Owner decision 1 in the shape: an attempt with no document at all is a representable submission.
    expect(SellerVerificationResponseSchema.safeParse({ verification }).success).toBe(true);
    // And a storefront that has never applied reads null rather than an invented attempt.
    expect(SellerVerificationResponseSchema.safeParse({ verification: null }).success).toBe(true);
    for (const field of [
      'id',
      'sellerUserId',
      'reviewedAt',
      'reviewedBy',
      'decisionReason',
      'expiresAt',
      'emailVerifiedAt',
      'phoneVerifiedAt',
    ]) {
      expect(
        SellerVerificationSchema.safeParse({ ...verification, [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });

  it('documents six operations, whose failures are all ProblemDetails naming no reviewer', () => {
    const operations = [
      ['/v1/sellers/me/verification', 'get', 'getV1SellersMeVerification', '200'],
      ['/v1/sellers/me/verification', 'post', 'postV1SellersMeVerification', '201'],
      [
        '/v1/sellers/me/verification/documents/uploads',
        'post',
        'postV1SellersMeVerificationDocumentUploads',
        '201',
      ],
      [
        '/v1/sellers/me/verification/documents',
        'post',
        'postV1SellersMeVerificationDocuments',
        '201',
      ],
      [
        '/v1/sellers/me/verification/documents/{documentId}',
        'delete',
        'deleteV1SellersMeVerificationDocument',
        '200',
      ],
      [
        '/v1/sellers/me/verification/submission',
        'post',
        'postV1SellersMeVerificationSubmission',
        '200',
      ],
    ] as const;

    for (const [path, method, operationId, success] of operations) {
      const operation = (doc.paths?.[path] as Record<string, DocumentedOperation> | undefined)?.[
        method
      ];
      expect(operation?.operationId, path).toBe(operationId);
      expect(Object.keys(operation?.responses ?? {}), path).toContain(success);
      for (const [code, response] of Object.entries(operation?.responses ?? {})) {
        if (Number(code) < 400) continue;
        const schema = (response as DocumentedResponse).content?.[
          'application/problem+json'
        ]?.schema;
        expect(schema, `${path} ${code}`).toBeDefined();
        // Every failure is the shared ProblemDetails shape: no operation grows a bespoke error body with a
        // rejection reason, a moderator or a note in it.
        expect(JSON.stringify(schema ?? {}), `${path} ${code}`).not.toMatch(
          /reviewedBy|decisionReason|reviewNote|moderator|sellerUserId/,
        );
      }
    }
  });

  it('starts an attempt and submits one with no body at all', () => {
    // A body would be somewhere to put a status, and a status the caller can send is a status the caller can
    // choose. Neither operation has one.
    for (const path of ['/v1/sellers/me/verification', '/v1/sellers/me/verification/submission']) {
      const operations = doc.paths?.[path] as Record<string, DocumentedOperation>;
      expect(operations['post']?.requestBody, path).toBeUndefined();
    }
  });

  it('never mentions approving, rejecting or a decision reason in its own descriptions', () => {
    // The prose is part of the contract: a description that told a seller how to be approved would be
    // describing an operation this surface does not have.
    const prose = Object.entries(doc.paths ?? {})
      .filter(([path]) => path.startsWith('/v1/sellers/me/verification'))
      .flatMap(([, methods]) => Object.values(methods as Record<string, DocumentedOperation>))
      .map((operation) => `${operation.summary ?? ''} ${operation.description ?? ''}`)
      .join(' ');
    expect(prose).not.toMatch(/\bapprove\b|\bapproves\b|\breject\b|\brejects\b/i);
    // It does say what it cannot do, which is the point of saying anything about a decision at all.
    expect(prose).toMatch(/sole authority/);
    expect(prose).toMatch(/owner decision 1/);
    expect(prose).toMatch(/owner decision 3/);
  });
});

/* -------------------------------------------------------------------------------------------------------- *
 * Phase 6-J — the read-only seller surfaces
 *
 * These tests exist to hold the contract to one promise: **these five operations can only read**. So they
 * check absences as carefully as presences — no request body anywhere, no status a caller could send, no
 * moderation or reviewer field in either direction, no ledger or payout material, and no money that is a
 * JavaScript number.
 * -------------------------------------------------------------------------------------------------------- */
describe('the seller read surfaces', () => {
  const doc = generateOpenApiDocument();
  const READ_PATHS = [
    '/v1/sellers/me/orders',
    '/v1/sellers/me/reviews',
    '/v1/sellers/me/earnings',
    '/v1/sellers/me/promotions',
    '/v1/sellers/me/analytics',
  ] as const;

  it('documents five operations, every one a GET and nothing else', () => {
    for (const path of READ_PATHS) {
      const methods = doc.paths?.[path] as Record<string, DocumentedOperation> | undefined;
      expect(Object.keys(methods ?? {}), path).toEqual(['get']);
    }
  });

  it('accepts no request body on any of them', () => {
    // A body would be somewhere to put a status, an id or an amount. None of them has one.
    for (const path of READ_PATHS) {
      const operation = (doc.paths?.[path] as Record<string, DocumentedOperation>)['get'];
      expect(operation?.requestBody, path).toBeUndefined();
    }
  });

  it('answers 200 and never a 429, because a read consumes no write bucket', () => {
    for (const path of READ_PATHS) {
      const operation = (doc.paths?.[path] as Record<string, DocumentedOperation>)['get'];
      expect(Object.keys(operation?.responses ?? {}), path).toContain('200');
      expect(Object.keys(operation?.responses ?? {}), path).not.toContain('429');
      expect(Object.keys(operation?.responses ?? {}), path).toContain('404');
    }
  });

  it('uses ProblemDetails for every failure, naming no reviewer or private field', () => {
    for (const path of READ_PATHS) {
      const operation = (doc.paths?.[path] as Record<string, DocumentedOperation>)['get'];
      for (const [code, response] of Object.entries(operation?.responses ?? {})) {
        if (Number(code) < 400) continue;
        const schema = (response as DocumentedResponse).content?.[
          'application/problem+json'
        ]?.schema;
        expect(schema, `${path} ${code}`).toBeDefined();
        expect(JSON.stringify(schema ?? {}), `${path} ${code}`).not.toMatch(
          /reviewedBy|moderationReason|decisionReason|sellerUserId|payout|ledger/i,
        );
      }
    }
  });

  it('never promises an action in its own descriptions', () => {
    // The prose is part of the contract: a description that told a seller how to refund an order, moderate a
    // review or withdraw a balance would be describing operations this surface does not have.
    const prose = READ_PATHS.map((path) => {
      const operation = (doc.paths?.[path] as Record<string, DocumentedOperation>)['get'];
      return `${operation?.summary ?? ''} ${operation?.description ?? ''}`;
    }).join(' ');
    expect(prose).toMatch(/read-only/i);
    // Each of these appears only inside an explicit denial, so the assertion is on the denial's presence.
    expect(prose).toMatch(/creates, pays for, ships, cancels and refunds nothing/);
    expect(prose).toMatch(/publishes, hides, removes, replies to and moderates nothing/);
    expect(prose).toMatch(/creates, schedules, pays for, pauses, cancels and refunds nothing/);
    expect(prose).toMatch(/no withdrawal, payout or transfer operation anywhere in this API/);
    expect(prose).toMatch(/no listing-level analytics operation/);
  });

  it('carries every money amount as a decimal string beside its own currency', () => {
    const order = {
      orderNumber: 'MP-26-001001',
      orderType: 'product',
      status: 'completed',
      currencyCode: 'EGP',
      currencyDecimalPlaces: 2,
      subtotalMinor: '100000',
      shippingTotalMinor: '5000',
      taxTotalMinor: '2000',
      discountTotalMinor: '1000',
      commissionTotalMinor: '8000',
      grandTotalMinor: '106000',
      sellerNetMinor: '98000',
      itemCount: 1,
      placedAt: '2026-05-01T10:00:00.000Z',
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      completedAt: null,
      cancelledAt: null,
      items: [
        {
          title: 'Title As Purchased',
          slug: 'a-listing',
          listingTypeCode: 'product',
          quantity: 2,
          cancelledQuantity: 0,
          unitPriceMinor: '50000',
          lineTotalMinor: '101000',
        },
      ],
    };
    expect(SellerOrderSchema.safeParse(order).success).toBe(true);
    // A number is refused, which is the standing post-6-G money rule expressed as a type.
    expect(SellerOrderSchema.safeParse({ ...order, grandTotalMinor: 106000 }).success).toBe(false);
    expect(SellerOrderSchema.safeParse({ ...order, sellerNetMinor: 98000 }).success).toBe(false);
    expect(
      SellerOrderSchema.safeParse({
        ...order,
        items: [{ ...order.items[0], unitPriceMinor: 50000 }],
      }).success,
    ).toBe(false);
  });

  it('refuses any private or staff field on an order or its items', () => {
    const order = {
      orderNumber: 'MP-26-001001',
      orderType: 'product',
      status: 'completed',
      currencyCode: 'EGP',
      currencyDecimalPlaces: 2,
      subtotalMinor: '1',
      shippingTotalMinor: '0',
      taxTotalMinor: '0',
      discountTotalMinor: '0',
      commissionTotalMinor: '0',
      grandTotalMinor: '1',
      sellerNetMinor: '1',
      itemCount: 0,
      placedAt: '2026-05-01T10:00:00.000Z',
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      completedAt: null,
      cancelledAt: null,
      items: [],
    };
    for (const field of [
      'id',
      'sellerUserId',
      'buyerUserId',
      'checkoutId',
      'commissionSnapshot',
      'cancellationPolicySnapshot',
    ]) {
      expect(SellerOrderSchema.safeParse({ ...order, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('returns a review’s own state but never a moderator’s words', () => {
    const review = {
      orderNumber: 'MP-26-001001',
      rating: 5,
      title: 'Great',
      body: 'Very good seller.',
      status: 'hidden',
      publishedAt: '2026-05-10T10:00:00.000Z',
      createdAt: '2026-05-09T10:00:00.000Z',
      replyBody: null,
      replyStatus: null,
      replyCreatedAt: null,
    };
    // A seller reads their own review in every state, hidden included.
    expect(SellerReviewSchema.safeParse(review).success).toBe(true);
    for (const field of [
      'id',
      'buyerUserId',
      'sellerUserId',
      'orderId',
      'moderationReason',
      'moderatedBy',
      'moderatedAt',
      'autoHiddenReason',
    ]) {
      expect(SellerReviewSchema.safeParse({ ...review, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('keeps the rating summary in the view’s own unit, and nullable', () => {
    const summary = {
      reviewCount: 1,
      averageRatingBasisPoints: 50_000,
      fiveStarCount: 1,
      fourStarCount: 0,
      threeStarCount: 0,
      twoStarCount: 0,
      oneStarCount: 0,
      latestReviewAt: '2026-05-10T10:00:00.000Z',
    };
    expect(SellerReviewSummarySchema.safeParse(summary).success).toBe(true);
    // Basis points: five stars is 50000, and anything above it is not a rating.
    expect(
      SellerReviewSummarySchema.safeParse({ ...summary, averageRatingBasisPoints: 50_001 }).success,
    ).toBe(false);
    // A 0-5 float is refused, so nobody can quietly convert the unit at this boundary.
    expect(
      SellerReviewSummarySchema.safeParse({ ...summary, averageRatingBasisPoints: 5 }).success,
    ).toBe(true);
    // No summary at all is representable, and is not the same as a summary of zeros.
    expect(
      SellerReviewsResponseSchema.safeParse({ summary: null, reviews: [], nextCursor: null }).success,
    ).toBe(true);
  });

  it('exposes three balances per currency and nothing from the ledger', () => {
    const balance = {
      currencyCode: 'EGP',
      currencyDecimalPlaces: 2,
      pendingMinor: '12000',
      availableMinor: '98000',
      reservedMinor: '3000',
      updatedAt: '2026-05-01T10:00:00.000Z',
    };
    expect(SellerBalanceSchema.safeParse(balance).success).toBe(true);
    // No total: adding the three would be a claim about what the seller is owed.
    for (const field of [
      'totalMinor',
      'sellerUserId',
      'ledgerAccountId',
      'journalId',
      'payoutId',
      'withdrawalId',
      'destinationMaskedSnapshot',
      'providerPayoutRef',
    ]) {
      expect(SellerBalanceSchema.safeParse({ ...balance, [field]: 'x' }).success, field).toBe(false);
    }
    expect(SellerBalanceSchema.safeParse({ ...balance, availableMinor: 98000 }).success).toBe(false);
    // Earning nothing yet is an empty list, not an error and not a zero balance.
    expect(SellerEarningsResponseSchema.safeParse({ balances: [] }).success).toBe(true);
  });

  it('names a promotion by its listing and carries no snapshot or key', () => {
    const promotion = {
      listingSlug: 'a-listing',
      listingTitle: 'A Listing',
      status: 'active',
      currencyCode: 'EGP',
      currencyDecimalPlaces: 2,
      priceMinor: '25000',
      refundedAmountMinor: '0',
      priority: 10,
      durationDays: 7,
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-05-08T00:00:00.000Z',
      activatedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
      expiredAt: null,
      cancelledAt: null,
      createdAt: '2026-04-30T00:00:00.000Z',
    };
    expect(SellerPromotionSchema.safeParse(promotion).success).toBe(true);
    for (const field of [
      'id',
      'promotionPackageId',
      'listingId',
      'sellerUserId',
      'packageSnapshot',
      'idempotencyKey',
      'paymentMethod',
      'cancellationReason',
    ]) {
      expect(SellerPromotionSchema.safeParse({ ...promotion, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('carries the rollup’s three totals and no derived metric', () => {
    const performance = {
      listingSlug: 'a-listing',
      listingTitle: 'A Listing',
      status: 'active',
      firstDay: '2026-05-01',
      lastDay: '2026-05-02',
      impressions: '2500',
      views: '450',
      clicks: '75',
    };
    expect(SellerPromotionPerformanceSchema.safeParse(performance).success).toBe(true);
    // Bigint sums travel as strings, for the same reason the money does.
    expect(
      SellerPromotionPerformanceSchema.safeParse({ ...performance, impressions: 2500 }).success,
    ).toBe(false);
    // No KPI this repository has not defined.
    for (const field of ['clickThroughRate', 'conversionRate', 'ctr', 'promotionId', 'listingId']) {
      expect(
        SellerPromotionPerformanceSchema.safeParse({ ...performance, [field]: 1 }).success,
        field,
      ).toBe(false);
    }
  });
});
