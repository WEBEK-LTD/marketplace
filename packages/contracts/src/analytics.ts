import { ListingStatusSchema } from './moderation.js';
import { z } from './zod.js';

/**
 * Listing analytics (0102): the daily rollup, read by its owner and by staff.
 *
 * Everything here is a **count**, and a count is not money. `listing_analytics` stores `bigint` totals, which
 * cannot cross a JSON boundary as numbers without risking precision, so they travel as decimal integer strings
 * — for the same reason a minor amount does, and by a different schema. {@link AnalyticsCountSchema} carries no
 * currency, no amount semantics, no decimal places and no dependency on `@repo/money`, so nothing downstream can
 * mistake a click for a piastre.
 *
 * **What is not here, and why.** There are no impressions and no views: 0101 ingests neither, and their
 * definitions — the visibility threshold and the dedupe window — are a Phase 9 decision. There is therefore no
 * rate, ratio, click-through or conversion either, because none of them has a denominator in this schema and
 * inventing one would be inventing a KPI. There is no unique-session or unique-visitor count: 0013 stores an
 * absent session digest as a zero-length value rather than null, so every anonymous event shares one, and a
 * distinct count would report all anonymous traffic as a single visitor. There is no `source` dimension: only
 * two of 0013's six values are ever emitted and the browse-surface taxonomy is deliberately undecided.
 *
 * **Nothing identifies anybody.** No field carries an account, a session digest or a device. A seller reads
 * their own listings by ownership; staff read every listing and see a seller's **public storefront slug**,
 * never an account identifier.
 */

/**
 * A `bigint` count as a decimal integer string: `'0'`, `'1'`, `'4294967296'`.
 *
 * Deliberately its own schema rather than the money one. The two happen to share a regular expression today and
 * mean entirely different things: a minor amount belongs to a currency with a decimal place count, and a count
 * of clicks belongs to nothing. Reusing the money schema here would put analytics on the currency rules — and
 * would invite a reader to render a click count through a money formatter.
 */
export const AnalyticsCountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'a count is a non-negative decimal integer')
  .openapi('AnalyticsCount');

/** The window a read may cover, in days. The server clamps; the client cannot widen it. */
export const LISTING_ANALYTICS_DEFAULT_DAYS = 30;
export const LISTING_ANALYTICS_MAX_DAYS = 365;

export const ListingAnalyticsWindowSchema = z
  .number()
  .int()
  .min(1)
  .max(LISTING_ANALYTICS_MAX_DAYS);

// ---------------------------------------------------------------------------------------------------
// The seller's own listings
// ---------------------------------------------------------------------------------------------------

/**
 * One of the caller's listings, with its totals over the window.
 *
 * Four totals, summed from rows a scheduled job already computed. `favorites` and `shares` read zero until a
 * control on some surface fires them — both are accepted by the ingestion contract and by the database, and
 * nothing in the catalogue emits either yet. That is a surfaces gap, and reporting it honestly as zero is
 * better than hiding the column.
 */
export const SellerListingPerformanceSchema = z
  .object({
    listingSlug: z.string().min(1),
    listingTitle: z.string().min(1),
    listingStatus: ListingStatusSchema,
    /** The earliest and latest rolled-up day inside the window, not the window's own edges. */
    firstDay: z.string().min(1),
    lastDay: z.string().min(1),
    clicks: AnalyticsCountSchema,
    contacts: AnalyticsCountSchema,
    favorites: AnalyticsCountSchema,
    shares: AnalyticsCountSchema,
  })
  .strict()
  .openapi('SellerListingPerformance');

export const SellerListingAnalyticsResponseSchema = z
  .object({
    /** The window these totals cover, in days, as the server resolved it. */
    days: ListingAnalyticsWindowSchema,
    listings: z.array(SellerListingPerformanceSchema),
  })
  .strict()
  .openapi('SellerListingAnalyticsResponse');

// ---------------------------------------------------------------------------------------------------
// The staff surface
// ---------------------------------------------------------------------------------------------------

/**
 * How many rows one page may carry.
 *
 * This is the **public** maximum and it is the authority. The reader behind it clamps at this number
 * **plus one**, because the API asks for `limit + 1` to learn whether another page exists; a ceiling
 * equal to the maximum would eat that probe row and report no next page (0106). This figure must not
 * move without moving that ceiling with it.
 */
export const LISTING_ANALYTICS_DEFAULT_LIMIT = 25;
export const LISTING_ANALYTICS_MAX_LIMIT = 100;

/**
 * One listing's day, as staff read it.
 *
 * A day at a time rather than a total, because the staff question is "what happened and when", where a seller's
 * is "how is my listing doing". `sellerSlug` is the storefront's public address — the same way every other
 * console surface names a seller — and is null only for a listing whose owner has no storefront row, which the
 * catalogue should not produce.
 */
export const ListingAnalyticsRowSchema = z
  .object({
    day: z.string().min(1),
    listingSlug: z.string().min(1),
    listingTitle: z.string().min(1),
    listingStatus: ListingStatusSchema,
    sellerSlug: z.string().min(1).nullable(),
    clicks: AnalyticsCountSchema,
    contacts: AnalyticsCountSchema,
    favorites: AnalyticsCountSchema,
    shares: AnalyticsCountSchema,
    /** When the rollup last recomputed this row. A re-run moves it; the counts may not change. */
    computedAt: z.string().min(1),
  })
  .strict()
  .openapi('ListingAnalyticsRow');

export const ListingAnalyticsResponseSchema = z
  .object({
    days: ListingAnalyticsWindowSchema,
    items: z.array(ListingAnalyticsRowSchema),
    /** Opaque. The position it encodes is the server's, and a client that edits it is refused. */
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .openapi('ListingAnalyticsResponse');

export type AnalyticsCount = z.infer<typeof AnalyticsCountSchema>;
export type SellerListingPerformance = z.infer<typeof SellerListingPerformanceSchema>;
export type SellerListingAnalyticsResponse = z.infer<typeof SellerListingAnalyticsResponseSchema>;
export type ListingAnalyticsRow = z.infer<typeof ListingAnalyticsRowSchema>;
export type ListingAnalyticsResponse = z.infer<typeof ListingAnalyticsResponseSchema>;
