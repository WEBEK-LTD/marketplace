import { PhoneE164Schema } from './contact-change.js';
import { MinorAmountSchema } from './listings.js';
import { z } from './zod.js';

/**
 * The public seller profile (Phase 4-E).
 *
 * Five fields, and they are the whole of what a guest may learn about a seller. Not the seller's
 * identifier, legal name, e-mail address, phone number, verification state, internal status, location
 * beyond the city, or any timestamp — none of which the reader behind this contract even selects.
 *
 * `availability` sits beside the seller rather than inside it, for the same reason a listing's does: it
 * describes the state of the page, not a property of the person. A suspended seller answers 200 with an
 * `unavailable` marker and a `noindex` page; a pending, closed or unknown seller is a 404 with no body at
 * all, so the three cannot be told apart.
 *
 * V1 carries no listings, services, ratings, review counts or statistics. The profile is a profile.
 */

/** Whether the profile is live, or a shell saying the seller is currently unavailable. */
export const SELLER_AVAILABILITY = ['available', 'unavailable'] as const;
export type SellerAvailability = (typeof SELLER_AVAILABILITY)[number];
export const SellerAvailabilitySchema = z.enum(SELLER_AVAILABILITY);

/**
 * The seller, as the public may see them.
 *
 * `contentLanguage` travels with the bio because the bio is seller-written content: D7 stores it in the
 * language it was written in and never translates it, so a page in Arabic may carry an English bio and
 * has to say so for a screen reader to read it correctly.
 */
export const PublicSellerProfileSchema = z
  .object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
    bio: z.string().nullable(),
    contentLanguage: z.string().min(2).nullable(),
    city: z.string().nullable(),
  })
  .strict()
  .openapi('PublicSellerProfile');

export const SellerProfileResponseSchema = z
  .object({
    seller: PublicSellerProfileSchema,
    availability: SellerAvailabilitySchema,
  })
  .strict()
  .openapi('SellerProfileResponse');

export type PublicSellerProfile = z.infer<typeof PublicSellerProfileSchema>;
export type SellerProfileResponse = z.infer<typeof SellerProfileResponseSchema>;

/**
 * The authenticated seller's own identity (Phase 6-A).
 *
 * A different contract from {@link PublicSellerProfileSchema} for a different question, and deliberately
 * not an extension of it. The public profile is what a guest may learn about somebody else and hides the
 * account's state entirely; this is what a seller may learn about their own storefront, so it reports the
 * state and drops the presentational fields a dashboard does not need.
 *
 * Six fields, and the omissions are the point. No `userId`: the browser has no use for the seller's own
 * identifier — every action it can take is authorised by the session — and a field that is never needed
 * is a field that cannot leak. No `legalName`, no contact e-mail or phone, no `suspensionReason`, no logo
 * or banner object path, no timestamp, nothing about verification documents and nothing about moderation.
 *
 * `status` and `verificationStatus` are two separate business states and stay separate here, because they
 * answer different questions: whether the storefront is trading, and how far its review has got.
 */
export const SELLER_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export const SellerStatusSchema = z.enum(SELLER_STATUSES);

export const SELLER_VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export const SellerVerificationStatusSchema = z.enum(SELLER_VERIFICATION_STATUSES);

export const SellerIdentitySchema = z
  .object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
    status: SellerStatusSchema,
    verificationStatus: SellerVerificationStatusSchema,
    city: z.string().nullable(),
    countryCode: z.string().length(2),
  })
  .strict()
  .openapi('SellerIdentity');

export const SellerIdentityResponseSchema = z
  .object({
    seller: SellerIdentitySchema,
  })
  .strict()
  .openapi('SellerIdentityResponse');

export type SellerStatus = z.infer<typeof SellerStatusSchema>;
export type SellerVerificationStatus = z.infer<typeof SellerVerificationStatusSchema>;
export type SellerIdentity = z.infer<typeof SellerIdentitySchema>;
export type SellerIdentityResponse = z.infer<typeof SellerIdentityResponseSchema>;

/**
 * Creating one's own storefront (Phase 6-C).
 *
 * **What is not here is the contract.** There is no `userId`: the owner is the authenticated caller and
 * the API takes it from the verified session, so a request has no field that could name somebody else.
 * There is no `status` and no `verificationStatus`: a new storefront is always `pending` and `unverified`,
 * decided in the database by literals rather than by anything sent. There is no `suspensionReason`, no
 * `verifiedAt`, no timestamp, no object path, no role and no verification document. The schema is
 * `.strict()`, so every one of those arrives as a validation failure rather than being quietly dropped —
 * a silently ignored `"status": "active"` and a refused one look the same to an honest client and very
 * different to a probing one.
 *
 * **Every limit is migration 0009's**, read off the table rather than chosen here: the slug's own regex and
 * its 3..50 length, a display name of 2..80 characters, a bio of at most 2000, and the E.164 phone pattern
 * the column already enforces, reused from {@link PhoneE164Schema} rather than written out a second time.
 * `contentLanguage` follows the same convention the public profile uses — a short code string, with the
 * foreign key onto `public.locales` as the authority on which codes exist — and `countryCode` is checked
 * for shape here and for being marketplace-enabled (D17) in the database.
 *
 * **The slug is permanent.** It becomes the storefront's public address at `/seller/<slug>`, and nothing
 * in Phase 6 edits it. That is a fact about the product, not about this schema, but it is the reason the
 * slug is required at creation and validated against the database's own pattern rather than a looser one:
 * a value that cannot be corrected later must not be accepted loosely now.
 */

/** The slug shape `seller_profiles_slug_format` enforces: lower case, 3..50, no edge hyphen. */
export const SELLER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

export const SellerSlugSchema = z
  .string()
  .regex(SELLER_SLUG_PATTERN, {
    message:
      'The seller address may use lower-case letters, numbers and hyphens, must be 3 to 50 characters, and cannot start or end with a hyphen.',
  })
  .openapi('SellerSlug');

/** Trimmed on the way in, because the database's length check is on the trimmed value. */
export const SellerDisplayNameSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length >= 2 && value.length <= 80, {
    message: 'The display name must be 2 to 80 characters.',
  });

/** Optional free text: absent, or something with content in it. An empty box is not a value. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: 'The value cannot be empty.' })
    .nullish();

export const SellerOnboardingRequestSchema = z
  .object({
    slug: SellerSlugSchema,
    displayName: SellerDisplayNameSchema,
    legalName: optionalText(200),
    bio: optionalText(2000),
    // The same convention the public profile uses for this field; `public.locales` decides which codes
    // exist, and a code that is not one answers as a validation failure from the database.
    contentLanguage: z.string().min(2).max(10).nullish(),
    countryCode: z.string().length(2),
    governorate: optionalText(120),
    city: optionalText(120),
    contactEmail: z
      .string()
      .max(320)
      .transform((value) => value.trim())
      .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
        message: 'The contact email address is not valid.',
      })
      .nullish(),
    contactPhone: PhoneE164Schema.nullish(),
  })
  .strict()
  .openapi('SellerOnboardingRequest');

/**
 * What a creation answers with: the 6-A projection of the storefront that was actually stored.
 *
 * The same six fields the seller's own dashboard reads, so a client renders what committed instead of
 * echoing what it sent — and the same omissions, for the same reason: no identifier, no contact detail,
 * no legal name, no suspension reason, no object path, no timestamp. Its own component rather than a reuse
 * of {@link SellerIdentityResponseSchema}, which stays exactly as 6-A shipped it.
 */
export const SellerOnboardingResponseSchema = z
  .object({
    seller: SellerIdentitySchema,
  })
  .strict()
  .openapi('SellerOnboardingResponse');

export type SellerOnboardingRequest = z.infer<typeof SellerOnboardingRequestSchema>;
export type SellerOnboardingResponse = z.infer<typeof SellerOnboardingResponseSchema>;

/**
 * Editing one's own storefront (Phase 6-D).
 *
 * **What is absent is again the contract.** No `slug` — the public address is permanent, so there is no
 * field here that could rename it, and an attempt to send one is a validation failure rather than a value
 * quietly ignored. No `userId`, no `status`, no `verificationStatus`, no suspension or closure field, no
 * timestamp, no object path, no role. Nine editable fields, `.strict()`, and nothing else exists to send.
 *
 * **Three states per field, and the JSON says which.** A partial update has to distinguish "leave this
 * alone" from "set this to nothing", and JSON already does: a key that is absent is the first, a key whose
 * value is `null` is the second. So every field here is `.optional()` — absent means preserve — and the
 * seven fields 0009 declares nullable are additionally `.nullable()`, where `null` means clear. The two the
 * table declares `not null`, `displayName` and `countryCode`, are optional but **not** nullable: they can be
 * changed and never emptied, and `null` is refused by the schema rather than by the database.
 *
 * An empty string is not a third state. A form's blank box is `''`, which means the person cleared it, so
 * the optional text fields refuse `''` and a client that wants to clear one sends `null` — one way to say
 * one thing. `{}` is a valid request: an edit that changes nothing changes nothing.
 *
 * Every limit is 0009's, reused from the onboarding schema above rather than restated, so the two cannot
 * drift: the same display-name rule, the same bio maximum, the same `PhoneE164Schema`, the same e-mail
 * shape and length, and the same two-character country code the database resolves against its own table.
 */
export const SellerProfileUpdateRequestSchema = z
  .object({
    displayName: SellerDisplayNameSchema.optional(),
    legalName: optionalText(200),
    bio: optionalText(2000),
    contentLanguage: z.string().min(2).max(10).nullish(),
    countryCode: z.string().length(2).optional(),
    governorate: optionalText(120),
    city: optionalText(120),
    contactEmail: z
      .string()
      .max(320)
      .transform((value) => value.trim())
      .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
        message: 'The contact email address is not valid.',
      })
      .nullish(),
    contactPhone: PhoneE164Schema.nullish(),
  })
  .strict()
  .openapi('SellerProfileUpdateRequest');

/**
 * What an edit answers with: the 6-A projection of the storefront as it now stands.
 *
 * The same six fields, read back from the row that committed, so a surface renders what was stored rather
 * than what it hoped for — and so a client never has to assume its own edit succeeded in order to display
 * the result. Its own component rather than a reuse of the onboarding one, which stays as 6-C shipped it.
 */
export const SellerProfileUpdateResponseSchema = z
  .object({
    seller: SellerIdentitySchema,
  })
  .strict()
  .openapi('SellerProfileUpdateResponse');

export type SellerProfileUpdateRequest = z.infer<typeof SellerProfileUpdateRequestSchema>;
export type SellerProfileUpdateResponse = z.infer<typeof SellerProfileUpdateResponseSchema>;

/**
 * Seller profile media (Phase 6-E).
 *
 * The approved upload flow is the spec's: **API issues a signed URL → browser uploads → API confirms.**
 * These are the contracts for the first and third steps; the second happens between the browser and storage
 * and carries no project credential at all.
 *
 * **The request describes the file, never its destination.** A caller sends a media kind, a content type and
 * a byte size. There is no `objectPath`, no `bucket`, no `slug`, no `fileName` and no seller in the request
 * schema, and the strict object means any of them is a validation failure rather than a value that is quietly
 * dropped. The path comes back from the server, derived in the database from the caller's own storefront.
 *
 * **The response carries the minimum the upload needs**: where to PUT the bytes, the path that was
 * authorized, when the authorization expires and the size ceiling. It carries no storage credential, no
 * project key and no bearer token of this project's own — the signed URL is opaque, short-lived and bound to
 * that one object path, which is the whole of what C15 means by an API-issued signed URL.
 *
 * **The confirmation returns booleans, not paths.** After an upload the browser tells the API which kind it
 * uploaded and where; the API answers only whether each kind is now set. A client already knows the path it
 * just used, and the other one is none of its business.
 */

/** The two media a storefront has, matching the two columns `seller_profiles` already holds. */
export const SELLER_MEDIA_KINDS = ['logo', 'banner'] as const;
export const SellerMediaKindSchema = z.enum(SELLER_MEDIA_KINDS).openapi('SellerMediaKind');

/**
 * The image types the `seller-media` bucket allows.
 *
 * Restated here so a browser is refused before a round trip; the bucket row remains the authority, and the
 * database refuses anything this list would let through. No SVG: an SVG is a script container, and a
 * storefront logo has no need to be one.
 */
export const SELLER_MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const SellerMediaContentTypeSchema = z
  .enum(SELLER_MEDIA_CONTENT_TYPES)
  .openapi('SellerMediaContentType');

/** The bucket's own ceiling, restated for the same reason and no other. */
export const SELLER_MEDIA_MAX_BYTES = 5_242_880;

export const SellerMediaUploadRequestSchema = z
  .object({
    mediaKind: SellerMediaKindSchema,
    contentType: SellerMediaContentTypeSchema,
    byteSize: z.number().int().positive().max(SELLER_MEDIA_MAX_BYTES),
  })
  .strict()
  .openapi('SellerMediaUploadRequest');

export const SellerMediaUploadSchema = z
  .object({
    mediaKind: SellerMediaKindSchema,
    /** Where the bytes go. Opaque, short-lived, and bound to `objectPath` alone. */
    uploadUrl: z.string().url(),
    /** The path that was authorized. The client sends it back to confirm, and chooses none of it. */
    objectPath: z.string().min(1),
    expiresAt: z.string().datetime(),
    maxByteSize: z.number().int().positive(),
  })
  .strict()
  .openapi('SellerMediaUpload');

export const SellerMediaUploadResponseSchema = z
  .object({
    upload: SellerMediaUploadSchema,
  })
  .strict()
  .openapi('SellerMediaUploadResponse');

export const SellerMediaAttachRequestSchema = z
  .object({
    mediaKind: SellerMediaKindSchema,
    objectPath: z.string().min(1).max(512),
  })
  .strict()
  .openapi('SellerMediaAttachRequest');

/** Whether each kind is set. Deliberately not the paths. */
export const SellerMediaStateSchema = z
  .object({
    hasLogo: z.boolean(),
    hasBanner: z.boolean(),
  })
  .strict()
  .openapi('SellerMediaState');

export const SellerMediaAttachResponseSchema = z
  .object({
    media: SellerMediaStateSchema,
  })
  .strict()
  .openapi('SellerMediaAttachResponse');

export type SellerMediaKind = z.infer<typeof SellerMediaKindSchema>;
export type SellerMediaContentType = z.infer<typeof SellerMediaContentTypeSchema>;
export type SellerMediaUploadRequest = z.infer<typeof SellerMediaUploadRequestSchema>;
export type SellerMediaUpload = z.infer<typeof SellerMediaUploadSchema>;
export type SellerMediaUploadResponse = z.infer<typeof SellerMediaUploadResponseSchema>;
export type SellerMediaAttachRequest = z.infer<typeof SellerMediaAttachRequestSchema>;
export type SellerMediaState = z.infer<typeof SellerMediaStateSchema>;
export type SellerMediaAttachResponse = z.infer<typeof SellerMediaAttachResponseSchema>;

/**
 * The seller's own listings (Phase 6-F).
 *
 * S-8's four operations — create a draft, edit a draft, submit it for review, archive a live listing —
 * plus the readback a seller needs in order to use them. **No new model and no new state**: every status
 * name below is migration 0011's own, and the two the seller can cause are the two 0011's owner-write
 * policy already admits.
 *
 * **Everything is addressed by slug.** A listing by its own slug, a category by its slug, so the seller
 * surface carries no listing identifier, no category identifier and no seller identifier at all — the
 * same stance 6-A took for the storefront itself. A slug that belongs to somebody else answers 404,
 * identically to one that does not exist, so asking cannot reveal that a listing exists.
 *
 * **What is absent is the contract, again.** There is no `status` field in any request: submission and
 * archival are their own operations, so a status the caller could send would be a status the caller could
 * choose. There is no `sellerUserId`, no `listingId`, no `approvedAt`, `publishedAt`, `deletedAt`,
 * `viewCount`, moderation record, rejection reason or status history anywhere in this file. Every request
 * object is `.strict()`, so each of those arrives as a validation failure rather than a value that is
 * quietly dropped.
 */

/**
 * The listing statuses a seller may see on their own listing.
 *
 * 0011's ten-name vocabulary minus `deleted`, which the readback never returns — a deleted listing is not
 * listed at all, so there is no state here a client has to know how to render and cannot reach.
 */
export const SELLER_LISTING_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'active',
  'sold',
  'expired',
  'archived',
  'rejected',
  'suspended',
] as const;
export type SellerListingStatus = (typeof SELLER_LISTING_STATUSES)[number];
export const SellerListingStatusSchema = z
  .enum(SELLER_LISTING_STATUSES)
  .openapi('SellerListingStatus');

/** The listing types `public.listing_types` holds. The table remains the authority. */
export const SELLER_LISTING_TYPES = ['product', 'service'] as const;
export const SellerListingTypeSchema = z.enum(SELLER_LISTING_TYPES).openapi('SellerListingType');

/**
 * The slug shape `listings_slug_format` enforces: lower case, 3..120, no edge hyphen.
 *
 * A different length from the seller slug and deliberately not shared with it: these are two columns with
 * two check constraints, and a single constant would make one of them wrong the moment either changed.
 */
export const LISTING_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$/;

export const ListingSlugSchema = z
  .string()
  .regex(LISTING_SLUG_PATTERN, {
    message:
      'The listing address may use lower-case letters, numbers and hyphens, must be 3 to 120 characters, and cannot start or end with a hyphen.',
  })
  .openapi('ListingSlug');

/** 0011's own title bounds, measured on the trimmed value as the check constraint measures them. */
export const ListingTitleSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .refine((value) => value.length >= 3 && value.length <= 140, {
    message: 'The title must be 3 to 140 characters.',
  });

/** 0011's own description bounds, likewise. */
export const ListingDescriptionSchema = z
  .string()
  .max(24_000)
  .transform((value) => value.trim())
  .refine((value) => value.length >= 10 && value.length <= 20_000, {
    message: 'The description must be 10 to 20,000 characters.',
  });

/**
 * A price in minor units, or none at all.
 *
 * A draft may have no price: 0011 binds its price rule to the live states only. Submission is where a
 * price becomes required, and only for what approval would require — which is 0048's rule, not a new one.
 */
export const ListingPriceMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SELLER_LISTINGS_DEFAULT_LIMIT = 20;
export const SELLER_LISTINGS_MAX_LIMIT = 50;

/**
 * One of the seller's own listings, as their own dashboard reads it.
 *
 * Eighteen fields, and the omissions are the same ones the database reader makes: no identifier of any
 * kind, no `approvedAt` or `publishedAt`, no `deletedAt`, no `viewCount`, no moderation action and no
 * rejection reason. `mediaCount` is a count rather than a list of paths, because a listings index needs
 * to say "3 photos" and has no business knowing where they live.
 */
export const SellerListingSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    listingTypeCode: SellerListingTypeSchema,
    categorySlug: z.string().min(1),
    status: SellerListingStatusSchema,
    currencyCode: z.string().length(3),
    priceMinor: z.number().int().nullable(),
    isNegotiable: z.boolean(),
    contentLanguage: z.string().min(2),
    countryCode: z.string().length(2),
    governorate: z.string().nullable(),
    city: z.string().nullable(),
    mediaCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('SellerListing');

export const SellerListingsResponseSchema = z
  .object({
    listings: z.array(SellerListingSchema),
    /**
     * An opaque continuation, or null when this is the last page. Its contents are this API's business:
     * a client that parsed it would be depending on the sort order, which is not part of the contract.
     */
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerListingsResponse');

/**
 * Creating a draft.
 *
 * The required fields are exactly 0011's `not null` columns, so this is the minimum valid seller-owned
 * listing the existing schema permits — **and media is not among them**, which is what makes S-9 true
 * here without a special case. Neither is a price.
 *
 * `slug` is required at creation because it becomes the listing's public address, and `listings_slug_rule`
 * keeps a permanent record of every address a listing has held. There is no field for `status`: a draft is
 * the only thing this operation can create, decided in the database by a literal.
 */
export const SellerListingCreateRequestSchema = z
  .object({
    slug: ListingSlugSchema,
    title: ListingTitleSchema,
    description: ListingDescriptionSchema,
    listingTypeCode: SellerListingTypeSchema,
    categorySlug: z.string().min(1).max(160),
    contentLanguage: z.string().min(2).max(10),
    currencyCode: z.string().length(3),
    countryCode: z.string().length(2),
    priceMinor: ListingPriceMinorSchema.nullish(),
    isNegotiable: z.boolean().optional(),
    governorate: optionalText(120),
    city: optionalText(120),
  })
  .strict()
  .openapi('SellerListingCreateRequest');

/**
 * Editing a draft.
 *
 * Nine fields, `.strict()`, and the three states of a partial update told apart the way 6-D tells them
 * apart: a key that is absent preserves the stored value, and `null` clears it for the three columns 0011
 * allows to be empty. The six the table declares `not null` are optional but not nullable — they can be
 * changed and never emptied, and `null` is refused here rather than by the database.
 *
 * `slug`, `listingTypeCode` and `categorySlug` are **absent**, so none of them can be edited: the slug
 * accumulates permanent redirect history that a draft has no business accumulating, and the type decides
 * which detail table a listing would own. Both are deliberate narrowings of 6-F, not oversights.
 */
export const SellerListingUpdateRequestSchema = z
  .object({
    title: ListingTitleSchema.optional(),
    description: ListingDescriptionSchema.optional(),
    priceMinor: ListingPriceMinorSchema.nullish(),
    isNegotiable: z.boolean().optional(),
    contentLanguage: z.string().min(2).max(10).optional(),
    currencyCode: z.string().length(3).optional(),
    countryCode: z.string().length(2).optional(),
    governorate: optionalText(120),
    city: optionalText(120),
  })
  .strict()
  .openapi('SellerListingUpdateRequest');

/**
 * What every one of the four writes answers with: the address and the status of the row that committed.
 *
 * One component for all four rather than four identical ones, because all four answer the same question —
 * *what is this listing now?* — and a client that re-reads the index after a write needs no more than
 * that. It is the committed status, not the requested one: nothing here is optimistic, and a surface that
 * renders this is rendering what the database did.
 */
export const SellerListingMutationResponseSchema = z
  .object({
    listing: z
      .object({
        slug: z.string().min(1),
        status: SellerListingStatusSchema,
      })
      .strict()
      .openapi('SellerListingRef'),
  })
  .strict()
  .openapi('SellerListingMutationResponse');

export type SellerListingType = z.infer<typeof SellerListingTypeSchema>;
export type SellerListing = z.infer<typeof SellerListingSchema>;
export type SellerListingsResponse = z.infer<typeof SellerListingsResponseSchema>;
export type SellerListingCreateRequest = z.infer<typeof SellerListingCreateRequestSchema>;
export type SellerListingUpdateRequest = z.infer<typeof SellerListingUpdateRequestSchema>;
export type SellerListingMutationResponse = z.infer<typeof SellerListingMutationResponseSchema>;

/**
 * The seller's own services (Phase 6-G).
 *
 * **A service is a listing.** `listing_type_code = 'service'` plus at most one `listing_service_details`
 * row, whose primary key *is* the listing id. So there is no service status, no service address and no
 * service owner here: the status vocabulary is {@link SellerListingStatusSchema}, the address is
 * {@link ListingSlugSchema}, and a write answers with {@link SellerListingMutationResponseSchema} — 6-F's
 * components, reused rather than reproduced under new names. What 6-G adds is the five detail fields and a
 * readback that carries them.
 *
 * **Submission and archival have no contracts here**, because they have no operations here: a service is
 * submitted and archived through 6-F's own two operations, which are already service-aware — 0048's
 * exemption for a service priced per engagement is checked inside the submitter. A second pair would be a
 * second copy of the state machine.
 *
 * **Money is the repository's, not this file's.** `priceMinor` is {@link MinorAmountSchema}: an integer in
 * the currency's minor unit, carried as a decimal string, which is how every other contract in this
 * repository carries `listings.price_minor` and which does not lose precision at the top of a bigint. The
 * currency's own minor unit travels beside it, read from `public.currencies` exactly as the public 4-C
 * reader reads it, so a surface can render an amount without assuming a divisor. No currency code is named
 * anywhere in this file.
 *
 * **What is absent is the contract.** No `sellerUserId`, `listingId`, `categoryId`, `status` in a request,
 * `approvedAt`, `publishedAt`, `deletedAt`, `viewCount`, moderation record or rejection reason. Every
 * request object is `.strict()`, so each of those is a validation failure rather than a value quietly
 * dropped.
 */

/** How the seller priced the work. The same two the detail table allows, and the same names 4-C publishes. */
export const SELLER_SERVICE_PRICING_MODELS = ['fixed', 'custom'] as const;
export type SellerServicePricingModel = (typeof SELLER_SERVICE_PRICING_MODELS)[number];
export const SellerServicePricingModelSchema = z
  .enum(SELLER_SERVICE_PRICING_MODELS)
  .openapi('SellerServicePricingModel');

/** The detail table's own window, restated so a browser is refused before a round trip. */
export const ServiceDeliveryDaysSchema = z.number().int().min(1).max(365);
/** Its own floor. Zero revisions is a fact a seller may state, not an absence. */
export const ServiceRevisionsSchema = z.number().int().min(0).max(32_767);
/** Its own ceiling. */
export const SERVICE_SCOPE_MAX_LENGTH = 5000;

export const SELLER_SERVICES_DEFAULT_LIMIT = 20;
export const SELLER_SERVICES_MAX_LIMIT = 50;

/**
 * One of the seller's own services, as their own dashboard reads it.
 *
 * The five detail fields are all nullable, and that is the schema speaking rather than a convenience: the
 * detail row is separate and optional, so a service that has none has stated nothing about how the work is
 * priced — which is different from having stated zero revisions, and the contract keeps the two apart.
 */
export const SellerServiceSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    categorySlug: z.string().min(1),
    status: SellerListingStatusSchema,
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    priceMinor: MinorAmountSchema.nullable(),
    isNegotiable: z.boolean(),
    contentLanguage: z.string().min(2),
    countryCode: z.string().length(2),
    governorate: z.string().nullable(),
    city: z.string().nullable(),
    pricingModel: SellerServicePricingModelSchema.nullable(),
    deliveryDays: ServiceDeliveryDaysSchema.nullable(),
    revisionsIncluded: ServiceRevisionsSchema.nullable(),
    requiresBrief: z.boolean().nullable(),
    scope: z.string().nullable(),
    mediaCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('SellerService');

export const SellerServicesResponseSchema = z
  .object({
    services: z.array(SellerServiceSchema),
    /** Opaque, as the listings cursor is, and for the same reason. */
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerServicesResponse');

/**
 * Creating a service draft.
 *
 * The required fields are the listings table's own not-null columns, minus the listing type, which is not a
 * field here at all: this operation creates a service and nothing else. So a draft needs **no media, no
 * price and no detail row** — all three are what makes S-9 true without a special case.
 *
 * `pricingModel` decides whether a detail row exists. Omit it and none is written, which is exactly the
 * state a service created through 6-F alone is in. State it and the other four may be stated with it; state
 * one of them without it and the request is refused, because a revision count that belongs to no pricing
 * model is not a fact about a service.
 */
export const SellerServiceCreateRequestSchema = z
  .object({
    slug: ListingSlugSchema,
    title: ListingTitleSchema,
    description: ListingDescriptionSchema,
    categorySlug: z.string().min(1).max(160),
    contentLanguage: z.string().min(2).max(10),
    currencyCode: z.string().length(3),
    countryCode: z.string().length(2),
    priceMinor: MinorAmountSchema.nullish(),
    isNegotiable: z.boolean().optional(),
    governorate: optionalText(120),
    city: optionalText(120),
    pricingModel: SellerServicePricingModelSchema.optional(),
    deliveryDays: ServiceDeliveryDaysSchema.optional(),
    revisionsIncluded: ServiceRevisionsSchema.optional(),
    requiresBrief: z.boolean().optional(),
    scope: optionalText(SERVICE_SCOPE_MAX_LENGTH),
  })
  .strict()
  .openapi('SellerServiceCreateRequest');

/**
 * Editing a service draft.
 *
 * Fourteen fields: 6-F's nine listing columns and this increment's five detail columns. Absent preserves,
 * and `null` clears — for `priceMinor`, `governorate` and `city`, which the listings table allows to be
 * empty, and for `deliveryDays` and `scope`, which the detail table does.
 *
 * `pricingModel: null` is the one field whose null means more than "empty this column": it withdraws the
 * whole detail row, because the other four hang off it. A request that withdraws the model while also
 * stating one of those four is contradictory and is refused rather than resolved in either direction.
 *
 * `revisionsIncluded` and `requiresBrief` are optional but **not** nullable: the detail table declares both
 * `not null` with a default, so they can be changed and never emptied.
 *
 * `slug`, `listingTypeCode` and `categorySlug` are absent, exactly as they are from 6-F's listing edit, and
 * for the same reasons.
 */
export const SellerServiceUpdateRequestSchema = z
  .object({
    title: ListingTitleSchema.optional(),
    description: ListingDescriptionSchema.optional(),
    priceMinor: MinorAmountSchema.nullish(),
    isNegotiable: z.boolean().optional(),
    contentLanguage: z.string().min(2).max(10).optional(),
    currencyCode: z.string().length(3).optional(),
    countryCode: z.string().length(2).optional(),
    governorate: optionalText(120),
    city: optionalText(120),
    pricingModel: SellerServicePricingModelSchema.nullish(),
    deliveryDays: ServiceDeliveryDaysSchema.nullish(),
    revisionsIncluded: ServiceRevisionsSchema.optional(),
    requiresBrief: z.boolean().optional(),
    scope: optionalText(SERVICE_SCOPE_MAX_LENGTH),
  })
  .strict()
  .openapi('SellerServiceUpdateRequest');

export type SellerService = z.infer<typeof SellerServiceSchema>;
export type SellerServicesResponse = z.infer<typeof SellerServicesResponseSchema>;
export type SellerServiceCreateRequest = z.infer<typeof SellerServiceCreateRequestSchema>;
export type SellerServiceUpdateRequest = z.infer<typeof SellerServiceUpdateRequestSchema>;

/* -------------------------------------------------------------------------------------------------------- *
 * Phase 6-I — the seller's own verification submission
 *
 * Submission only. There is no operation here that reaches a decision, and there is no field anywhere in
 * this section that a reviewer would write: no `status` on any request, no `reviewedAt`, no `reviewedBy`, no
 * `decisionReason` and no document `reviewNote`. The attempt's status is returned because it is the
 * applicant's own fact; it is never accepted.
 *
 * What is deliberately absent from every response: the verification's own id, the seller's id, the reviewer,
 * the review time, the decision reason, the expiry, and — most carefully — the document's `objectPath`. A
 * path is a capability in a private bucket, so it travels outward exactly once, in the authorization the
 * client immediately sends back, and never in a readback.
 *
 * The three ratified 6-I decisions are visible in these shapes:
 *   1. No minimum document count. Nothing here requires one, and `documentCount` is reported, not enforced.
 *   2. A verified storefront is offered no form. `POST /verification` answers
 *      `SELLER_VERIFICATION_ALREADY_VERIFIED` and creates nothing.
 *   3. A document may be removed only while the attempt is `draft` or `submitted`. The DELETE operation
 *      exists for exactly that window; the SECURITY DEFINER writer enforces it, not the browser.
 * -------------------------------------------------------------------------------------------------------- */

/**
 * The six document types `seller_verification_documents.document_type` allows, in 0009's own order.
 *
 * Discovered from the schema, not chosen here. No type is required and no number of them is: the reviewer
 * judges whether what was sent is enough.
 */
export const SELLER_VERIFICATION_DOCUMENT_TYPES = [
  'national_id',
  'passport',
  'commercial_register',
  'tax_card',
  'bank_statement',
  'other',
] as const;
export type SellerVerificationDocumentType = (typeof SELLER_VERIFICATION_DOCUMENT_TYPES)[number];
export const SellerVerificationDocumentTypeSchema = z
  .enum(SELLER_VERIFICATION_DOCUMENT_TYPES)
  .openapi('SellerVerificationDocumentType');

/**
 * 0009's three per-document review states.
 *
 * Read only. A seller sees the state of their own document because it is a fact about their own document,
 * but no request in this section carries it: `pending` is the column's default and the only value a
 * submission can produce.
 */
export const SELLER_VERIFICATION_DOCUMENT_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type SellerVerificationDocumentStatus =
  (typeof SELLER_VERIFICATION_DOCUMENT_STATUSES)[number];
export const SellerVerificationDocumentStatusSchema = z
  .enum(SELLER_VERIFICATION_DOCUMENT_STATUSES)
  .openapi('SellerVerificationDocumentStatus');

/**
 * 0009's six attempt states.
 *
 * All six can be read; only the first two are reachable from this surface. `under_review`, `approved`,
 * `rejected` and `expired` are the reviewer's and the schedule's, and no operation here assigns them —
 * `seller_verifications`' own constraints make `approved` and `rejected` impossible without a reviewer and a
 * review time, neither of which this surface can supply.
 */
export const SELLER_VERIFICATION_STATES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'expired',
] as const;
export type SellerVerificationState = (typeof SELLER_VERIFICATION_STATES)[number];
export const SellerVerificationStateSchema = z
  .enum(SELLER_VERIFICATION_STATES)
  .openapi('SellerVerificationState');

/**
 * The content types the `verification-documents` bucket allows, in the bucket's own order.
 *
 * Restated so a browser is refused before a round trip; the bucket row remains the authority and the
 * database refuses anything this list would let through. No SVG — an SVG is a script container — and no
 * office formats: 0012 allows two image types and PDF, and this is not the place to widen that.
 */
export const SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type SellerVerificationDocumentContentType =
  (typeof SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES)[number];
export const SellerVerificationDocumentContentTypeSchema = z
  .enum(SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES)
  .openapi('SellerVerificationDocumentContentType');

/** The bucket's own 20 MiB ceiling, restated for the same reason and no other. */
export const SELLER_VERIFICATION_DOCUMENT_MAX_BYTES = 20_971_520;

/** A stored `bigint` byte size, carried as a decimal string. See `SellerVerificationDocumentSchema`. */
export const StoredByteSizeSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a decimal count of bytes');

export const SellerVerificationDocumentSchema = z
  .object({
    /**
     * The document's own id. The only identifier in this section, and it exists because removing a document
     * needs a way to name one; it identifies the document and nothing else — not the attempt, not the
     * storefront, not the account.
     */
    id: z.string().uuid(),
    documentType: SellerVerificationDocumentTypeSchema,
    /** The name the seller's own file had. Theirs, echoed back, trimmed by the database. */
    originalFilename: z.string().min(1),
    contentType: z.string().min(1),
    /**
     * The stored size. A decimal string rather than a number because the column is a `bigint` and this
     * repository carries a `bigint` as text end to end; the upload request below bounds the same quantity
     * with a number, because there it is bounded by 20 MiB and well inside what a double represents exactly.
     */
    byteSize: StoredByteSizeSchema,
    /** This document's own review state. Its review note is not here, and there is no field for one. */
    status: SellerVerificationDocumentStatusSchema,
    uploadedAt: z.string().datetime(),
  })
  .strict()
  .openapi('SellerVerificationDocument');

export const SellerVerificationSchema = z
  .object({
    status: SellerVerificationStateSchema,
    /** When the seller submitted, or `null` while it is still a draft. */
    submittedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    /**
     * Whether the account's email and phone are confirmed, as booleans rather than times. The database reads
     * them from `auth.users` at submission; a client states neither, and learns only whether the condition
     * approval will require is met.
     */
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    documentCount: z.number().int().min(0),
    documents: z.array(SellerVerificationDocumentSchema),
  })
  .strict()
  .openapi('SellerVerification');

export const SellerVerificationResponseSchema = z
  .object({
    /**
     * The caller's current attempt — the open one when there is one, otherwise the most recent decided one —
     * or `null` when they have never applied. `null` is not an error: a storefront with no attempt is the
     * ordinary starting state, and a verified storefront that was verified by another route also reads
     * `null` here.
     */
    verification: SellerVerificationSchema.nullable(),
  })
  .strict()
  .openapi('SellerVerificationResponse');

/** What a start or a submission answers: the status the database committed, and nothing else. */
export const SellerVerificationStateResponseSchema = z
  .object({
    status: SellerVerificationStateSchema,
  })
  .strict()
  .openapi('SellerVerificationStateResponse');

export const SellerVerificationUploadRequestSchema = z
  .object({
    documentType: SellerVerificationDocumentTypeSchema,
    contentType: SellerVerificationDocumentContentTypeSchema,
    byteSize: z.number().int().positive().max(SELLER_VERIFICATION_DOCUMENT_MAX_BYTES),
  })
  .strict()
  .openapi('SellerVerificationUploadRequest');

export const SellerVerificationUploadSchema = z
  .object({
    documentType: SellerVerificationDocumentTypeSchema,
    /** Where the bytes go. Opaque, short-lived, and bound to `objectPath` alone. */
    uploadUrl: z.string().url(),
    /**
     * The path that was authorized. The client sends it back to confirm and chooses no part of it: the
     * bucket, the storefront's own namespace, the document type and a fresh uuid are all the server's. This
     * is the only place a path is disclosed, and it is never returned by a readback.
     */
    objectPath: z.string().min(1),
    expiresAt: z.string().datetime(),
    maxByteSize: z.number().int().positive(),
  })
  .strict()
  .openapi('SellerVerificationUpload');

export const SellerVerificationUploadResponseSchema = z
  .object({
    upload: SellerVerificationUploadSchema,
  })
  .strict()
  .openapi('SellerVerificationUploadResponse');

export const SellerVerificationDocumentRequestSchema = z
  .object({
    documentType: SellerVerificationDocumentTypeSchema,
    objectPath: z.string().min(1).max(512),
    originalFilename: z.string().trim().min(1).max(255),
    contentType: SellerVerificationDocumentContentTypeSchema,
    byteSize: z.number().int().positive().max(SELLER_VERIFICATION_DOCUMENT_MAX_BYTES),
  })
  .strict()
  .openapi('SellerVerificationDocumentRequest');

/** What attaching or removing a document answers: how many the attempt now has. Never a path. */
export const SellerVerificationDocumentCountResponseSchema = z
  .object({
    documentCount: z.number().int().min(0),
  })
  .strict()
  .openapi('SellerVerificationDocumentCountResponse');

export type SellerVerificationDocument = z.infer<typeof SellerVerificationDocumentSchema>;
export type SellerVerification = z.infer<typeof SellerVerificationSchema>;
export type SellerVerificationResponse = z.infer<typeof SellerVerificationResponseSchema>;
export type SellerVerificationStateResponse = z.infer<typeof SellerVerificationStateResponseSchema>;
export type SellerVerificationUploadRequest = z.infer<typeof SellerVerificationUploadRequestSchema>;
export type SellerVerificationUpload = z.infer<typeof SellerVerificationUploadSchema>;
export type SellerVerificationUploadResponse = z.infer<
  typeof SellerVerificationUploadResponseSchema
>;
export type SellerVerificationDocumentRequest = z.infer<
  typeof SellerVerificationDocumentRequestSchema
>;
export type SellerVerificationDocumentCountResponse = z.infer<
  typeof SellerVerificationDocumentCountResponseSchema
>;

/* -------------------------------------------------------------------------------------------------------- *
 * Phase 6-J — the read-only seller surfaces
 *
 * Five read operations and not one write. There is no request body anywhere in this section, no mutation
 * schema, and no field that a seller could send: every shape below is a *response*, and the only inputs are a
 * page size and a cursor.
 *
 * **What is deliberately absent from every shape here.** No seller id, buyer id, order id, listing id,
 * promotion id, review id, checkout id, ledger account or journal. No moderation reason, moderator,
 * moderation time or auto-hidden reason. No commission snapshot, cancellation-policy snapshot, package
 * snapshot or idempotency key. No payout, payout destination, provider reference or bank detail. An order and
 * a review are named by `orderNumber`, the unique human reference the orders table already generates; a
 * promotion is named by the slug of the listing it promotes.
 *
 * **Money.** Every amount is {@link MinorAmountSchema} — an integer in the currency's smallest unit, as a
 * decimal string — beside an explicit `currencyCode` and that currency's own `currencyDecimalPlaces`. No
 * amount is a JavaScript number, no divisor is assumed, and no total is computed from the parts: the standing
 * post-6-G rule, applied to every new money field in this increment.
 *
 * **Counts** are plain integers where the database's own type is an integer, and {@link MinorAmountSchema} is
 * reused for the analytics totals, which are `bigint` sums.
 * -------------------------------------------------------------------------------------------------------- */

export const SELLER_READ_DEFAULT_LIMIT = 20;
export const SELLER_READ_MAX_LIMIT = 50;

/**
 * The order statuses the orders table allows, which depend on what was bought.
 *
 * Both lists are 0018's own, restated so a client can label a status rather than print it raw. Nothing here
 * can change one: there is no status field in any request in this section, because there is no request.
 */
export const SELLER_PRODUCT_ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refund_requested',
  'refunded',
  'disputed',
] as const;
export const SELLER_SERVICE_ORDER_STATUSES = [
  'pending_payment',
  'requested',
  'accepted',
  'in_progress',
  'delivered',
  'revision_requested',
  'completed',
  'cancelled',
  'disputed',
] as const;
/** The union, because one list renders both kinds of order. */
export const SELLER_ORDER_STATUSES = [
  ...new Set([...SELLER_PRODUCT_ORDER_STATUSES, ...SELLER_SERVICE_ORDER_STATUSES]),
] as const;
export type SellerOrderStatus = (typeof SELLER_ORDER_STATUSES)[number];
export const SellerOrderStatusSchema = z
  .enum(SELLER_ORDER_STATUSES as unknown as [string, ...string[]])
  .openapi('SellerOrderStatus');

export const SellerOrderItemSchema = z
  .object({
    /** The title as it was at purchase, from the order's own snapshot — not the listing's current title. */
    title: z.string().min(1),
    /** Likewise the slug at purchase. It addresses the public listing if it is still there, and nothing if not. */
    slug: z.string().min(1),
    listingTypeCode: SellerListingTypeSchema,
    quantity: z.number().int().min(0),
    cancelledQuantity: z.number().int().min(0),
    unitPriceMinor: MinorAmountSchema,
    lineTotalMinor: MinorAmountSchema,
  })
  .strict()
  .openapi('SellerOrderItem');

export const SellerOrderSchema = z
  .object({
    /** The order's own human reference. The only thing that names it, and it is not a database id. */
    orderNumber: z.string().min(1),
    orderType: SellerListingTypeSchema,
    status: SellerOrderStatusSchema,
    currencyCode: z.string().length(3),
    currencyDecimalPlaces: z.number().int().min(0).max(4),
    subtotalMinor: MinorAmountSchema,
    shippingTotalMinor: MinorAmountSchema,
    taxTotalMinor: MinorAmountSchema,
    discountTotalMinor: MinorAmountSchema,
    /** The platform's fee on this order: the seller's own cost, and the gap between the two totals below. */
    commissionTotalMinor: MinorAmountSchema,
    grandTotalMinor: MinorAmountSchema,
    /** What the order is worth to this seller once the commission is taken. */
    sellerNetMinor: MinorAmountSchema,
    itemCount: z.number().int().min(0),
    placedAt: z.string().datetime(),
    paidAt: z.string().datetime().nullable(),
    shippedAt: z.string().datetime().nullable(),
    deliveredAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    cancelledAt: z.string().datetime().nullable(),
    items: z.array(SellerOrderItemSchema),
  })
  .strict()
  .openapi('SellerOrder');

export const SellerOrdersResponseSchema = z
  .object({
    orders: z.array(SellerOrderSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerOrdersResponse');

/** 0026's four review states. Read only: no request in this section carries one. */
export const SELLER_REVIEW_STATUSES = ['published', 'pending_moderation', 'hidden', 'removed'] as const;
export type SellerReviewStatus = (typeof SELLER_REVIEW_STATUSES)[number];
export const SellerReviewStatusSchema = z
  .enum(SELLER_REVIEW_STATUSES)
  .openapi('SellerReviewStatus');

export const SellerReviewSchema = z
  .object({
    /** The order the review belongs to. Reviews are unique per order, so this names the review. */
    orderNumber: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().nullable(),
    body: z.string().nullable(),
    /**
     * The review's own state. A seller reads their own reviews in every state, which is the reviews table's
     * own rule for the owner — but never *why* a state was reached: there is no moderation reason,
     * moderator, moderation time or auto-hidden reason in this shape, and no field for one.
     */
    status: SellerReviewStatusSchema,
    publishedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    /** The seller's own reply, when they have written one. Its moderation fields are likewise absent. */
    replyBody: z.string().nullable(),
    replyStatus: SellerReviewStatusSchema.nullable(),
    replyCreatedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('SellerReview');

/**
 * The rating summary, exactly as `public.seller_ratings` defines it.
 *
 * The average is in **basis points** because that is the unit the view produces — 50000 is five stars — and
 * converting it here would mean re-deciding a rounding rule the view already settled. The view counts
 * published reviews only, so a storefront whose reviews are all hidden has no summary at all rather than a
 * summary of zero, and the two are different claims.
 */
export const SellerReviewSummarySchema = z
  .object({
    reviewCount: z.number().int().min(0),
    averageRatingBasisPoints: z.number().int().min(0).max(50_000),
    fiveStarCount: z.number().int().min(0),
    fourStarCount: z.number().int().min(0),
    threeStarCount: z.number().int().min(0),
    twoStarCount: z.number().int().min(0),
    oneStarCount: z.number().int().min(0),
    latestReviewAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('SellerReviewSummary');

export const SellerReviewsResponseSchema = z
  .object({
    /** `null` when the storefront has no published review. Not a summary of zeros. */
    summary: SellerReviewSummarySchema.nullable(),
    reviews: z.array(SellerReviewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerReviewsResponse');

/**
 * One currency's balance.
 *
 * The three amounts the balances table keeps, and no fourth computed from them: what a seller is "owed" is a
 * business statement no formula in this repository establishes, so the surface shows the three and lets the
 * seller read them. Nothing here comes from the ledger, a payout or a withdrawal.
 */
export const SellerBalanceSchema = z
  .object({
    currencyCode: z.string().length(3),
    currencyDecimalPlaces: z.number().int().min(0).max(4),
    pendingMinor: MinorAmountSchema,
    availableMinor: MinorAmountSchema,
    reservedMinor: MinorAmountSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .openapi('SellerBalance');

export const SellerEarningsResponseSchema = z
  .object({
    /** One row per currency the seller has earned in. Empty means they have earned nothing yet. */
    balances: z.array(SellerBalanceSchema),
  })
  .strict()
  .openapi('SellerEarningsResponse');

/** 0025's nine promotion states. Read only. */
export const SELLER_PROMOTION_STATUSES = [
  'draft',
  'pending_payment',
  'paid',
  'scheduled',
  'active',
  'paused',
  'expired',
  'cancelled',
  'refunded',
] as const;
export type SellerPromotionStatus = (typeof SELLER_PROMOTION_STATUSES)[number];
export const SellerPromotionStatusSchema = z
  .enum(SELLER_PROMOTION_STATUSES)
  .openapi('SellerPromotionStatus');

export const SellerPromotionSchema = z
  .object({
    /** The promoted listing, by its public address. What names the promotion. */
    listingSlug: z.string().min(1),
    listingTitle: z.string().min(1),
    status: SellerPromotionStatusSchema,
    currencyCode: z.string().length(3),
    currencyDecimalPlaces: z.number().int().min(0).max(4),
    priceMinor: MinorAmountSchema,
    refundedAmountMinor: MinorAmountSchema,
    priority: z.number().int(),
    durationDays: z.number().int(),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    activatedAt: z.string().datetime().nullable(),
    pausedAt: z.string().datetime().nullable(),
    expiredAt: z.string().datetime().nullable(),
    cancelledAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi('SellerPromotion');

export const SellerPromotionsResponseSchema = z
  .object({
    promotions: z.array(SellerPromotionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerPromotionsResponse');

/**
 * One promotion's performance, from the `promotion_analytics` rollup.
 *
 * Three totals, summed over the window from rows a scheduled job already computed. There is no rate, no
 * ratio and no click-through, because none of those has an established business definition in this
 * repository and inventing one would be inventing a KPI. The totals are `bigint` sums, so they are decimal
 * strings for the same reason the money is.
 */
export const SellerPromotionPerformanceSchema = z
  .object({
    listingSlug: z.string().min(1),
    listingTitle: z.string().min(1),
    status: SellerPromotionStatusSchema,
    firstDay: z.string().min(1),
    lastDay: z.string().min(1),
    impressions: MinorAmountSchema,
    views: MinorAmountSchema,
    clicks: MinorAmountSchema,
  })
  .strict()
  .openapi('SellerPromotionPerformance');

export const SELLER_ANALYTICS_DEFAULT_DAYS = 30;
export const SELLER_ANALYTICS_MAX_DAYS = 365;

export const SellerAnalyticsResponseSchema = z
  .object({
    /** The window these totals cover, in days, as the server resolved it. */
    days: z.number().int().min(1).max(SELLER_ANALYTICS_MAX_DAYS),
    promotions: z.array(SellerPromotionPerformanceSchema),
  })
  .strict()
  .openapi('SellerAnalyticsResponse');

export type SellerOrderItem = z.infer<typeof SellerOrderItemSchema>;
export type SellerOrder = z.infer<typeof SellerOrderSchema>;
export type SellerOrdersResponse = z.infer<typeof SellerOrdersResponseSchema>;
export type SellerReview = z.infer<typeof SellerReviewSchema>;
export type SellerReviewSummary = z.infer<typeof SellerReviewSummarySchema>;
export type SellerReviewsResponse = z.infer<typeof SellerReviewsResponseSchema>;
export type SellerBalance = z.infer<typeof SellerBalanceSchema>;
export type SellerEarningsResponse = z.infer<typeof SellerEarningsResponseSchema>;
export type SellerPromotion = z.infer<typeof SellerPromotionSchema>;
export type SellerPromotionsResponse = z.infer<typeof SellerPromotionsResponseSchema>;
export type SellerPromotionPerformance = z.infer<typeof SellerPromotionPerformanceSchema>;
export type SellerAnalyticsResponse = z.infer<typeof SellerAnalyticsResponseSchema>;
