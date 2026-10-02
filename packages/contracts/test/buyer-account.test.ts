import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DEFAULT_LIMIT,
  ACCOUNT_MAX_LIMIT,
  ADDRESS_PURPOSES,
  AddFavoriteRequestSchema,
  AddressInputSchema,
  AddressSchema,
  AddressesResponseSchema,
  BuyerProfileSchema,
  BuyerSettingsSchema,
  CountriesResponseSchema,
  DIGIT_STYLES,
  FavoriteItemSchema,
  FavoritesResponseSchema,
  PROBLEM_CODES,
  SAVED_SEARCH_NAME_MAX,
  SAVED_SEARCH_QUERY_MAX_BYTES,
  SavedSearchInputSchema,
  SavedSearchSchema,
  UpdateBuyerProfileRequestSchema,
  UpdateBuyerSettingsRequestSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * Phase 7-E — the buyer account contracts.
 *
 * The assertions that matter most are about absence. Every surface here is the caller's own, so the
 * decisive question for each schema is not what it carries but what it refuses to carry: an account
 * identifier anywhere, a role or permission on a profile, a matching timestamp on a saved-search
 * request, the free-form preferences object on settings.
 */

const listing = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'sofa',
  title: 'A sofa',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
};

const address = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Home',
  purpose: 'both' as const,
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  district: null,
  streetAddress: '12 Street',
  building: null,
  apartment: null,
  postalCode: null,
  landmark: null,
  isDefaultShipping: true,
  isDefaultBilling: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const addressInput = {
  purpose: 'both' as const,
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  streetAddress: '12 Street',
};

describe('7-E favorites', () => {
  it('carries the marketplace card when the listing is still visible', () => {
    const parsed = FavoriteItemSchema.safeParse({
      listingId: listing.id,
      savedAt: '2026-01-01T00:00:00.000Z',
      isAvailable: true,
      listing,
    });
    expect(parsed.success).toBe(true);
    // The money contract is the existing one: a decimal string of minor units, a code and a minor unit.
    expect(parsed.success && parsed.data.listing?.priceMinor).toBe('250000');
    expect(parsed.success && typeof parsed.data.listing?.priceMinor).toBe('string');
  });

  it('carries no card at all when it is not', () => {
    const parsed = FavoriteItemSchema.safeParse({
      listingId: listing.id,
      savedAt: '2026-01-01T00:00:00.000Z',
      isAvailable: false,
      listing: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a price sent as a number', () => {
    const parsed = FavoriteItemSchema.safeParse({
      listingId: listing.id,
      savedAt: '2026-01-01T00:00:00.000Z',
      isAvailable: true,
      listing: { ...listing, priceMinor: 250000 },
    });
    expect(parsed.success).toBe(false);
  });

  it('names no account anywhere', () => {
    expect(
      FavoriteItemSchema.safeParse({
        listingId: listing.id,
        savedAt: '2026-01-01T00:00:00.000Z',
        isAvailable: true,
        listing,
        userId: '33333333-3333-4333-8333-333333333333',
      }).success,
    ).toBe(false);
    expect(
      AddFavoriteRequestSchema.safeParse({
        listingId: listing.id,
        userId: '33333333-3333-4333-8333-333333333333',
      }).success,
    ).toBe(false);
  });

  it('requires a listing identifier that is an identifier', () => {
    expect(AddFavoriteRequestSchema.safeParse({ listingId: 'sofa' }).success).toBe(false);
    expect(AddFavoriteRequestSchema.safeParse({}).success).toBe(false);
  });

  it('pages like every other list in this project', () => {
    expect(ACCOUNT_DEFAULT_LIMIT).toBe(20);
    expect(ACCOUNT_MAX_LIMIT).toBe(50);
    expect(FavoritesResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(FavoritesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('7-E saved searches', () => {
  const stored = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Sofas',
    query: { q: 'sofa' },
    notify: true,
    lastMatchedAt: null,
    lastNotifiedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('returns the two matching timestamps as data', () => {
    expect(SavedSearchSchema.safeParse(stored).success).toBe(true);
    expect(SavedSearchSchema.safeParse({ ...stored, lastMatchedAt: '2026-02-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('accepts neither of them in a request, because nothing can write them', () => {
    expect(SavedSearchInputSchema.safeParse({ name: 'Sofas', query: {}, lastMatchedAt: null }).success).toBe(false);
    expect(SavedSearchInputSchema.safeParse({ name: 'Sofas', query: {}, lastNotifiedAt: null }).success).toBe(false);
  });

  it('trims the name and holds it to the stored length', () => {
    const parsed = SavedSearchInputSchema.safeParse({ name: '  Sofas  ', query: {} });
    expect(parsed.success && parsed.data.name).toBe('Sofas');
    expect(SavedSearchInputSchema.safeParse({ name: '   ', query: {} }).success).toBe(false);
    expect(SavedSearchInputSchema.safeParse({ name: 'x'.repeat(SAVED_SEARCH_NAME_MAX), query: {} }).success).toBe(true);
    expect(SavedSearchInputSchema.safeParse({ name: 'x'.repeat(SAVED_SEARCH_NAME_MAX + 1), query: {} }).success).toBe(false);
  });

  it('holds the query to an object below the stored size cap', () => {
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: { a: 1, b: [1, 2], c: { d: true } } }).success).toBe(true);
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: [] }).success).toBe(false);
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: 'sofa' }).success).toBe(false);
    const huge = { q: 'x'.repeat(SAVED_SEARCH_QUERY_MAX_BYTES) };
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: huge }).success).toBe(false);
  });

  it('treats notify as an ordinary stored preference', () => {
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: {} }).success).toBe(true);
    expect(SavedSearchInputSchema.safeParse({ name: 'S', query: {}, notify: true }).success).toBe(true);
    // Nothing schedules, no cadence, no channel: none of those fields exists to be sent.
    for (const field of ['frequency', 'cadence', 'channel', 'notifyEvery', 'matchInterval']) {
      expect(SavedSearchInputSchema.safeParse({ name: 'S', query: {}, [field]: 'daily' }).success).toBe(false);
    }
  });
});

describe('7-E addresses', () => {
  it('accepts the three purposes the schema permits and no others', () => {
    expect(ADDRESS_PURPOSES).toEqual(['shipping', 'billing', 'both']);
    for (const purpose of ADDRESS_PURPOSES) {
      expect(AddressInputSchema.safeParse({ ...addressInput, purpose }).success).toBe(true);
    }
    expect(AddressInputSchema.safeParse({ ...addressInput, purpose: 'warehouse' }).success).toBe(false);
  });

  it('normalises the country code and requires two letters', () => {
    const parsed = AddressInputSchema.safeParse({ ...addressInput, countryCode: ' eg ' });
    expect(parsed.success && parsed.data.countryCode).toBe('EG');
    expect(AddressInputSchema.safeParse({ ...addressInput, countryCode: 'EGY' }).success).toBe(false);
    expect(AddressInputSchema.safeParse({ ...addressInput, countryCode: '12' }).success).toBe(false);
  });

  it('holds the phone to the stored E.164 shape', () => {
    expect(AddressInputSchema.safeParse({ ...addressInput, phoneE164: '01000000001' }).success).toBe(false);
    expect(AddressInputSchema.safeParse({ ...addressInput, phoneE164: '+0100000000' }).success).toBe(false);
    expect(AddressInputSchema.safeParse({ ...addressInput, phoneE164: '+201000000001' }).success).toBe(true);
  });

  it('requires the parts the stored constraint requires, and trims them', () => {
    for (const field of ['recipientName', 'governorate', 'city', 'streetAddress']) {
      expect(AddressInputSchema.safeParse({ ...addressInput, [field]: '   ' }).success).toBe(false);
    }
    const parsed = AddressInputSchema.safeParse({ ...addressInput, city: '  Cairo  ' });
    expect(parsed.success && parsed.data.city).toBe('Cairo');
  });

  it('turns an empty optional part into an absence rather than an empty string', () => {
    const parsed = AddressInputSchema.safeParse({ ...addressInput, district: '   ' });
    expect(parsed.success && parsed.data.district).toBeNull();
  });

  it('refuses a default that contradicts its own purpose', () => {
    expect(AddressInputSchema.safeParse({ ...addressInput, purpose: 'billing', isDefaultShipping: true }).success).toBe(false);
    expect(AddressInputSchema.safeParse({ ...addressInput, purpose: 'shipping', isDefaultBilling: true }).success).toBe(false);
    expect(AddressInputSchema.safeParse({ ...addressInput, purpose: 'both', isDefaultShipping: true, isDefaultBilling: true }).success).toBe(true);
  });

  it('carries no account, no geography and nothing about an order', () => {
    expect(AddressSchema.safeParse(address).success).toBe(true);
    for (const field of ['userId', 'location', 'latitude', 'orderId', 'shippingMethod', 'deletedAt']) {
      expect(AddressSchema.safeParse({ ...address, [field]: 'x' }).success).toBe(false);
      expect(AddressInputSchema.safeParse({ ...addressInput, [field]: 'x' }).success).toBe(false);
    }
  });

  it('is returned unpaged', () => {
    expect(AddressesResponseSchema.safeParse({ items: [address] }).success).toBe(true);
    expect(AddressesResponseSchema.safeParse({ items: [address], nextCursor: null }).success).toBe(false);
  });
});

describe('7-E profile', () => {
  const profile = {
    id: '55555555-5555-4555-8555-555555555555',
    displayName: 'Amina',
    fullName: 'Amina Hassan',
    phoneE164: '+201000000001',
    localeCode: 'ar',
    timezone: 'Africa/Cairo',
    status: 'active' as const,
    emailVerifiedAt: null,
    phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('reads back the account’s own facts', () => {
    expect(BuyerProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('carries no role, no permission and no secret', () => {
    for (const field of ['role', 'roles', 'permissions', 'password', 'passwordHash', 'accessToken', 'email']) {
      expect(BuyerProfileSchema.safeParse({ ...profile, [field]: 'x' }).success).toBe(false);
    }
  });

  it('accepts only the four fields a person owns in a write', () => {
    expect(UpdateBuyerProfileRequestSchema.safeParse({ displayName: 'Amina' }).success).toBe(true);
    expect(UpdateBuyerProfileRequestSchema.safeParse({}).success).toBe(true);
    for (const field of ['phoneE164', 'status', 'emailVerifiedAt', 'phoneVerifiedAt', 'role', 'id', 'deletedAt']) {
      expect(UpdateBuyerProfileRequestSchema.safeParse({ [field]: 'x' }).success).toBe(false);
    }
  });

  it('trims the names and turns a blank one into an absence', () => {
    const parsed = UpdateBuyerProfileRequestSchema.safeParse({ displayName: '  Amina  ', fullName: '   ' });
    expect(parsed.success && parsed.data.displayName).toBe('Amina');
    expect(parsed.success && parsed.data.fullName).toBeNull();
  });
});

describe('7-E settings', () => {
  const settings = {
    notifyEmail: true,
    notifySms: false,
    notifyWhatsapp: false,
    notifyInApp: true,
    marketingOptIn: false,
    digitStyle: null,
  };

  it('is exactly the schema’s own switches', () => {
    expect(BuyerSettingsSchema.safeParse(settings).success).toBe(true);
    expect(DIGIT_STYLES).toEqual(['western', 'arabic_indic']);
    expect(BuyerSettingsSchema.safeParse({ ...settings, digitStyle: 'roman' }).success).toBe(false);
  });

  it('never exposes the free-form preferences object', () => {
    expect(BuyerSettingsSchema.safeParse({ ...settings, preferences: {} }).success).toBe(false);
    expect(UpdateBuyerSettingsRequestSchema.safeParse({ ...settings, preferences: {} }).success).toBe(false);
  });

  it('invents no business setting', () => {
    for (const field of ['currency', 'commissionRate', 'payoutMethod', 'theme', 'language', 'role']) {
      expect(UpdateBuyerSettingsRequestSchema.safeParse({ ...settings, [field]: 'x' }).success).toBe(false);
    }
  });

  it('is a whole-state write, so every switch is required', () => {
    expect(UpdateBuyerSettingsRequestSchema.safeParse(settings).success).toBe(true);
    expect(UpdateBuyerSettingsRequestSchema.safeParse({ notifyEmail: false }).success).toBe(false);
  });
});

describe('7-E country reference', () => {
  it('carries both names and the flag D17 tests', () => {
    expect(
      CountriesResponseSchema.safeParse({
        items: [{ code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', phoneCode: '20', isMarketplaceEnabled: true }],
      }).success,
    ).toBe(true);
  });
});

describe('7-E problem codes', () => {
  it('adds three, and each is something the caller can act on', () => {
    expect(PROBLEM_CODES).toContain('SAVED_SEARCH_NAME_TAKEN');
    expect(PROBLEM_CODES).toContain('ADDRESS_COUNTRY_NOT_SHIPPABLE');
    expect(PROBLEM_CODES).toContain('ACCOUNT_CURSOR_INVALID');
  });

  it('adds no code that names another account or a forbidden row', () => {
    for (const code of PROBLEM_CODES) {
      expect(code).not.toMatch(/FORBIDDEN|OTHER_USER|NOT_OWNER|ACCESS_DENIED/);
    }
  });
});

describe('7-E documented operations', () => {
  const doc = generateOpenApiDocument();

  it('documents every buyer surface under the caller’s own namespace', () => {
    expect(doc.paths?.['/v1/users/me/favorites']?.get?.operationId).toBe('getV1UsersMeFavorites');
    expect(doc.paths?.['/v1/users/me/favorites']?.post?.operationId).toBe('postV1UsersMeFavorites');
    expect(doc.paths?.['/v1/users/me/favorites/{listingId}']?.delete?.operationId).toBe('deleteV1UsersMeFavorite');
    expect(doc.paths?.['/v1/users/me/saved-searches']?.get?.operationId).toBe('getV1UsersMeSavedSearches');
    expect(doc.paths?.['/v1/users/me/saved-searches']?.post?.operationId).toBe('postV1UsersMeSavedSearches');
    expect(doc.paths?.['/v1/users/me/saved-searches/{savedSearchId}']?.patch?.operationId).toBe('patchV1UsersMeSavedSearch');
    expect(doc.paths?.['/v1/users/me/saved-searches/{savedSearchId}']?.delete?.operationId).toBe('deleteV1UsersMeSavedSearch');
    expect(doc.paths?.['/v1/users/me/addresses']?.get?.operationId).toBe('getV1UsersMeAddresses');
    expect(doc.paths?.['/v1/users/me/addresses']?.post?.operationId).toBe('postV1UsersMeAddresses');
    expect(doc.paths?.['/v1/users/me/addresses/{addressId}']?.patch?.operationId).toBe('patchV1UsersMeAddress');
    expect(doc.paths?.['/v1/users/me/addresses/{addressId}']?.delete?.operationId).toBe('deleteV1UsersMeAddress');
    expect(doc.paths?.['/v1/users/me/profile']?.get?.operationId).toBe('getV1UsersMeProfile');
    expect(doc.paths?.['/v1/users/me/profile']?.patch?.operationId).toBe('patchV1UsersMeProfile');
    expect(doc.paths?.['/v1/users/me/settings']?.get?.operationId).toBe('getV1UsersMeSettings');
    expect(doc.paths?.['/v1/users/me/settings']?.put?.operationId).toBe('putV1UsersMeSettings');
    expect(doc.paths?.['/v1/reference/countries']?.get?.operationId).toBe('getV1ReferenceCountries');
  });

  it('documents no saved-search match, checkout or shipping operation on a buyer surface', () => {
    // 6-J's seller orders read is a different surface and is left exactly where it is.
    const buyerPaths = Object.keys(doc.paths ?? {}).filter(
      (path) => path.startsWith('/v1/users/') || path === '/v1/reference/countries',
    );
    for (const path of buyerPaths) {
      expect(path).not.toMatch(/match|checkout|order|shipping/i);
    }
  });

  it('requires a session on every one of them', () => {
    const buyerPaths = Object.keys(doc.paths ?? {}).filter(
      (path) => path.startsWith('/v1/users/me/') || path === '/v1/reference/countries',
    );
    for (const path of buyerPaths) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
        const operation = doc.paths?.[path]?.[method];
        if (operation === undefined) continue;
        const names = (operation.parameters ?? []).map((parameter) =>
          'name' in parameter ? parameter.name : '',
        );
        expect(names).toContain('x-session-token');
        expect(operation.responses?.['401']).toBeDefined();
      }
    }
  });
});
