import { ListingSummarySchema } from './listings.js';
import { z } from './zod.js';

/**
 * The buyer account surfaces (Phase 7-E): favorites, saved searches, addresses, profile and settings.
 *
 * Five things a person owns about themselves, and the country reference an address form needs. Several
 * shapes here are decisions rather than conveniences.
 *
 *   * **No request names an account.** There is no `userId` anywhere below, in any request or any
 *     response. The caller is resolved from their own session before any of this is reached, and every
 *     reader and writer in migration 0067 is scoped to that account inside the statement. A schema with
 *     an account field would be a schema somebody could use to read or rewrite another person's account.
 *   * **A favorite is a saved row, not a live listing.** It reports whether its listing is still publicly
 *     visible, and carries the marketplace card only when it is. A favorite whose listing was withdrawn
 *     is still the person's own saved row and stays on their list so they can tidy it up; nothing about
 *     the hidden listing crosses.
 *   * **The listing card is the existing one.** `ListingSummary` is reused exactly as Phase 4-B defined
 *     it, including its money contract — a decimal string of minor units, an explicit currency code and
 *     the currency's own minor unit. No money field is introduced here and the 6-F listing-price
 *     contract is untouched.
 *   * **A saved search stores parameters, never results, and never triggers anything.** `notify` is the
 *     column migration 0013 already defines and is a stored preference, nothing more: there is no
 *     matching engine in this project and no operation below causes one to run. `lastMatchedAt` and
 *     `lastNotifiedAt` are returned as read-only data and appear in no request, because no writer in
 *     0067 can move them.
 *   * **Settings are the ones the schema defines.** The five notification switches and the digit style —
 *     every column of `user_settings` except the free-form `preferences` object, which has no approved
 *     keys and is therefore not exposed rather than guessed at.
 *   * **The profile cannot change what an account may do.** Four writable fields, none of them a role, a
 *     permission, a status or a verified contact.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Paging                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The same page size every other list in this project uses.
 *
 * This is the **public** maximum and it is the authority. The reader behind it clamps at this number
 * **plus one**, because the API asks for `limit + 1` to learn whether another page exists; a ceiling
 * equal to the maximum would eat that probe row and report no next page (0106). This figure must not
 * move without moving that ceiling with it.
 */
export const ACCOUNT_DEFAULT_LIMIT = 20;
export const ACCOUNT_MAX_LIMIT = 50;

/* ------------------------------------------------------------------------------------------------ */
/* Favorites                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One favorite.
 *
 * `listing` is the card when the listing is still publicly visible and `null` when it is not, which is
 * the same single visibility decision (`public.listing_is_visible`) every other surface follows. The two
 * fields are kept separate rather than collapsed into a nullable card so a surface never has to guess
 * whether a missing card means "withdrawn" or "failed to load".
 */
export const FavoriteItemSchema = z
  .object({
    listingId: z.uuid(),
    savedAt: z.iso.datetime(),
    isAvailable: z.boolean(),
    listing: ListingSummarySchema.nullable(),
  })
  .strict()
  .openapi('FavoriteItem');

export const FavoritesResponseSchema = z
  .object({
    items: z.array(FavoriteItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('FavoritesResponse');

export const AddFavoriteRequestSchema = z
  .object({ listingId: z.uuid() })
  .strict()
  .openapi('AddFavoriteRequest');

/**
 * What a favorite write did.
 *
 * `changed` is false for a favorite that was already saved and for one that was already gone. Both are
 * successes: the caller asked for a state and the state holds.
 */
export const FavoriteMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('FavoriteMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Saved searches                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export const SAVED_SEARCH_NAME_MAX = 120;
/**
 * The serialized size a stored query may reach.
 *
 * Migration 0013 caps the stored column at 8192 bytes (`saved_searches_query_size`). This is the same
 * rule expressed where a form can act on it, set below the storage cap so a request that passes here
 * cannot fail there over encoding overhead.
 */
export const SAVED_SEARCH_QUERY_MAX_BYTES = 4096;

/** An object of search parameters. Its keys are the search's own; this contract fixes only the shape. */
export const SavedSearchQuerySchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= SAVED_SEARCH_QUERY_MAX_BYTES,
    { message: 'The saved search is too large.' },
  )
  .openapi('SavedSearchQuery');

export const SavedSearchSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(SAVED_SEARCH_NAME_MAX),
    query: z.record(z.string(), z.unknown()),
    notify: z.boolean(),
    /** Written by a matching engine. None exists, so this is null on everything created today. */
    lastMatchedAt: z.iso.datetime().nullable(),
    lastNotifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('SavedSearch');

export const SavedSearchesResponseSchema = z
  .object({
    items: z.array(SavedSearchSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SavedSearchesResponse');

/**
 * Creating or editing a saved search.
 *
 * Three fields, because three are what a person owns: what it is called, what it searches for, and
 * whether it notifies. The name is trimmed here as well as in the database so a caller cannot store a
 * name that differs from what they typed only in whitespace.
 */
export const SavedSearchInputSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(SAVED_SEARCH_NAME_MAX)),
    query: SavedSearchQuerySchema,
    notify: z.boolean().optional(),
  })
  .strict()
  .openapi('SavedSearchInput');

export const SavedSearchCreatedResponseSchema = z
  .object({ id: z.uuid() })
  .strict()
  .openapi('SavedSearchCreatedResponse');

export const SavedSearchMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('SavedSearchMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Addresses                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** The three purposes `addresses_purpose_allowed` permits, and exactly those. */
export const ADDRESS_PURPOSES = ['shipping', 'billing', 'both'] as const;
export const AddressPurposeSchema = z.enum(ADDRESS_PURPOSES).openapi('AddressPurpose');

/** The E.164 shape `addresses_phone_format` enforces, expressed where a form can act on it. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

const requiredText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max));

const optionalText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const AddressSchema = z
  .object({
    id: z.uuid(),
    label: z.string().nullable(),
    purpose: AddressPurposeSchema,
    recipientName: z.string().min(1),
    phoneE164: z.string().regex(E164_PATTERN),
    countryCode: z.string().length(2),
    governorate: z.string().min(1),
    city: z.string().min(1),
    district: z.string().nullable(),
    streetAddress: z.string().min(1),
    building: z.string().nullable(),
    apartment: z.string().nullable(),
    postalCode: z.string().nullable(),
    landmark: z.string().nullable(),
    isDefaultShipping: z.boolean(),
    isDefaultBilling: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('Address');

/**
 * The address list.
 *
 * Unpaged on purpose: an account's addresses are a handful of rows the schema already orders by default
 * first, and a cursor here would be machinery for a list nobody scrolls.
 */
export const AddressesResponseSchema = z
  .object({ items: z.array(AddressSchema) })
  .strict()
  .openapi('AddressesResponse');

/**
 * Creating or editing an address.
 *
 * Every rule below is one the 0005 schema already enforces, restated where a form can act on it rather
 * than invented: the purposes, the E.164 phone shape, the required parts and the two-letter country
 * code. The stored geography point is deliberately absent — no approved surface captures or renders one.
 */
export const AddressInputSchema = z
  .object({
    label: optionalText(80),
    purpose: AddressPurposeSchema,
    recipientName: requiredText(160),
    phoneE164: z.string().regex(E164_PATTERN),
    countryCode: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/)),
    governorate: requiredText(120),
    city: requiredText(120),
    district: optionalText(120),
    streetAddress: requiredText(240),
    building: optionalText(60),
    apartment: optionalText(60),
    postalCode: optionalText(20),
    landmark: optionalText(160),
    isDefaultShipping: z.boolean().optional(),
    isDefaultBilling: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // 0005's addresses_default_shipping_purpose and addresses_default_billing_purpose, restated where a
    // form can show the person which field to change.
    if (value.isDefaultShipping === true && value.purpose === 'billing') {
      context.addIssue({
        code: 'custom',
        path: ['isDefaultShipping'],
        message: 'A billing address cannot be the default shipping address.',
      });
    }
    if (value.isDefaultBilling === true && value.purpose === 'shipping') {
      context.addIssue({
        code: 'custom',
        path: ['isDefaultBilling'],
        message: 'A shipping address cannot be the default billing address.',
      });
    }
  })
  .openapi('AddressInput');

export const AddressCreatedResponseSchema = z
  .object({ id: z.uuid() })
  .strict()
  .openapi('AddressCreatedResponse');

export const AddressMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('AddressMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Profile                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** The three statuses `profiles_status_allowed` permits. A deleted profile is never returned at all. */
export const PROFILE_STATUSES = ['active', 'suspended', 'deleted'] as const;
export const ProfileStatusSchema = z.enum(PROFILE_STATUSES).openapi('ProfileStatus');

/**
 * The caller's own profile.
 *
 * The phone number and the two verification timestamps are returned because they are facts the person
 * already knows about themselves and a security surface has to be able to show them. None of the three
 * is writable here: the number moves only through the verified contact-change flow, and the timestamps
 * only through the `auth.users` sync.
 */
export const BuyerProfileSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().nullable(),
    fullName: z.string().nullable(),
    phoneE164: z.string().nullable(),
    localeCode: z.string().nullable(),
    timezone: z.string().min(1),
    status: ProfileStatusSchema,
    emailVerifiedAt: z.iso.datetime().nullable(),
    phoneVerifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .openapi('BuyerProfile');

export const BuyerProfileResponseSchema = z
  .object({ profile: BuyerProfileSchema })
  .strict()
  .openapi('BuyerProfileResponse');

/** The four fields a person owns on their own profile, and no others. */
export const UpdateBuyerProfileRequestSchema = z
  .object({
    displayName: optionalText(80),
    fullName: optionalText(160),
    localeCode: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(35))
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    timezone: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(64))
      .optional(),
  })
  .strict()
  .openapi('UpdateBuyerProfileRequest');

export const BuyerProfileMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('BuyerProfileMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Settings                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** The two styles `user_settings_digit_style_allowed` permits; null means follow the locale (D15). */
export const DIGIT_STYLES = ['western', 'arabic_indic'] as const;
export const DigitStyleSchema = z.enum(DIGIT_STYLES).openapi('DigitStyle');

export const BuyerSettingsSchema = z
  .object({
    notifyEmail: z.boolean(),
    notifySms: z.boolean(),
    notifyWhatsapp: z.boolean(),
    notifyInApp: z.boolean(),
    marketingOptIn: z.boolean(),
    digitStyle: DigitStyleSchema.nullable(),
  })
  .strict()
  .openapi('BuyerSettings');

export const BuyerSettingsResponseSchema = z
  .object({ settings: BuyerSettingsSchema })
  .strict()
  .openapi('BuyerSettingsResponse');

/**
 * Writing settings.
 *
 * Every field is required, because this is a whole-state write: a form that sent only what it changed
 * would need a merge rule, and a merge rule is a second place the current state has to be known. Writing
 * the same values again is a success that changes nothing anybody can observe.
 */
export const UpdateBuyerSettingsRequestSchema = z
  .object({
    notifyEmail: z.boolean(),
    notifySms: z.boolean(),
    notifyWhatsapp: z.boolean(),
    notifyInApp: z.boolean(),
    marketingOptIn: z.boolean(),
    digitStyle: DigitStyleSchema.nullable(),
  })
  .strict()
  .openapi('UpdateBuyerSettingsRequest');

export const BuyerSettingsMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('BuyerSettingsMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Country reference                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One country an address form may offer.
 *
 * `isMarketplaceEnabled` is the flag D17's trigger actually tests, returned rather than applied: a
 * billing address is not restricted by it, so filtering the list here would remove a choice the schema
 * allows.
 */
export const CountryReferenceSchema = z
  .object({
    code: z.string().length(2),
    nameEn: z.string().min(1),
    nameAr: z.string().min(1),
    phoneCode: z.string().min(1),
    isMarketplaceEnabled: z.boolean(),
  })
  .strict()
  .openapi('CountryReference');

export const CountriesResponseSchema = z
  .object({ items: z.array(CountryReferenceSchema) })
  .strict()
  .openapi('CountriesResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type FavoriteItem = z.infer<typeof FavoriteItemSchema>;
export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>;
export type AddFavoriteRequest = z.infer<typeof AddFavoriteRequestSchema>;
export type FavoriteMutationResponse = z.infer<typeof FavoriteMutationResponseSchema>;
export type SavedSearch = z.infer<typeof SavedSearchSchema>;
export type SavedSearchesResponse = z.infer<typeof SavedSearchesResponseSchema>;
export type SavedSearchInput = z.infer<typeof SavedSearchInputSchema>;
export type SavedSearchCreatedResponse = z.infer<typeof SavedSearchCreatedResponseSchema>;
export type SavedSearchMutationResponse = z.infer<typeof SavedSearchMutationResponseSchema>;
export type AddressPurpose = z.infer<typeof AddressPurposeSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type AddressesResponse = z.infer<typeof AddressesResponseSchema>;
export type AddressInput = z.infer<typeof AddressInputSchema>;
export type AddressCreatedResponse = z.infer<typeof AddressCreatedResponseSchema>;
export type AddressMutationResponse = z.infer<typeof AddressMutationResponseSchema>;
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;
export type BuyerProfile = z.infer<typeof BuyerProfileSchema>;
export type BuyerProfileResponse = z.infer<typeof BuyerProfileResponseSchema>;
export type UpdateBuyerProfileRequest = z.infer<typeof UpdateBuyerProfileRequestSchema>;
export type BuyerProfileMutationResponse = z.infer<typeof BuyerProfileMutationResponseSchema>;
export type DigitStyle = z.infer<typeof DigitStyleSchema>;
export type BuyerSettings = z.infer<typeof BuyerSettingsSchema>;
export type BuyerSettingsResponse = z.infer<typeof BuyerSettingsResponseSchema>;
export type UpdateBuyerSettingsRequest = z.infer<typeof UpdateBuyerSettingsRequestSchema>;
export type BuyerSettingsMutationResponse = z.infer<typeof BuyerSettingsMutationResponseSchema>;
export type CountryReference = z.infer<typeof CountryReferenceSchema>;
export type CountriesResponse = z.infer<typeof CountriesResponseSchema>;
