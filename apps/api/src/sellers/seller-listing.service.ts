import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SELLER_LISTINGS_MAX_LIMIT,
  SELLER_LISTING_STATUSES,
  SELLER_LISTING_TYPES,
  type SellerListing,
  type SellerListingCreateRequest,
  type SellerListingStatus,
  type SellerListingType,
  type SellerListingUpdateRequest,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  InvalidSellerListingCursorError,
  SellerIdentityUnavailableError,
  SellerListingIncompleteError,
  SellerListingInvalidError,
  SellerListingNotEditableError,
  SellerListingNotFoundError,
  SellerListingSlugTakenError,
  SellerProfileNotEditableError,
  SellerProfileNotFoundError,
} from './seller-errors.js';
import {
  decodeSellerListingCursor,
  encodeSellerListingCursor,
  type SellerListingCursor,
} from './seller-listing-cursor.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * The seller's own listings (Phase 6-F).
 *
 * Every rule that looks like it lives here lives in migration 0061 instead, and this layer only turns its
 * outcome strings into the approved errors. There is no second ownership check, no second status check, no
 * second length limit and no second state machine — which is what keeps two copies of a rule from drifting,
 * and why no refusal can be produced here that the database would have allowed, or the reverse.
 *
 * **The caller names no owner and no state.** `userId` is the account the API resolved from the caller's own
 * access token; it is never read from a body, a query string or a path. None of the five database functions
 * has a parameter for a seller, a listing identifier or a status, so there is nothing for a request to say
 * even if it tried. Submission and archival are separate operations with no body at all, for the same reason:
 * a status a caller could send would be a status a caller could choose.
 *
 * **Absent and null are different requests.** JSON already distinguishes them and 0061 takes a set-flag and a
 * value per editable column, so this service is the translation between the two, exactly as 6-D's editor is.
 * `Object.hasOwn`, because `null` is a meaningful value here and also a falsy one.
 *
 * **Every write is limited before the database is touched**, so a flood costs a counter round trip rather
 * than a transaction, and the limiter fails closed: a counter that cannot be read refuses the attempt.
 *
 * **Nothing else happens.** Nothing is approved, activated, rejected, suspended, sold or deleted; no
 * moderation record is written; no media is touched; nobody is notified; no role is assigned. The audit trail
 * is 0011's own status-history trigger doing its ordinary job.
 */

export interface SellerListingRow {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly listingTypeCode: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly priceMinor: number | null;
  readonly isNegotiable: boolean;
  readonly contentLanguage: string;
  readonly countryCode: string;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly mediaCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly submittedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface SellerListingsQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursorCreatedAt: Date | null;
  readonly cursorSlug: string | null;
}

export interface SellerListingCreateInput {
  readonly userId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly listingTypeCode: string;
  readonly categorySlug: string;
  readonly contentLanguage: string;
  readonly currencyCode: string;
  readonly countryCode: string;
  readonly priceMinor: number | null;
  readonly isNegotiable: boolean | null;
  readonly governorate: string | null;
  readonly city: string | null;
}

export interface SellerListingUpdateInput {
  readonly userId: string;
  readonly slug: string;
  readonly setTitle: boolean;
  readonly title: string | null;
  readonly setDescription: boolean;
  readonly description: string | null;
  readonly setPriceMinor: boolean;
  readonly priceMinor: number | null;
  readonly setIsNegotiable: boolean;
  readonly isNegotiable: boolean | null;
  readonly setContentLanguage: boolean;
  readonly contentLanguage: string | null;
  readonly setCurrencyCode: boolean;
  readonly currencyCode: string | null;
  readonly setCountryCode: boolean;
  readonly countryCode: string | null;
  readonly setGovernorate: boolean;
  readonly governorate: string | null;
  readonly setCity: boolean;
  readonly city: string | null;
}

/** Every write answers the same three things: what happened, at what address, in what state. */
export interface SellerListingWriteResult {
  readonly outcome: string;
  readonly slug: string | null;
  readonly status: string | null;
}

export interface SellerListingStore {
  /** `app_private.seller_listings(...)` (0061). */
  sellerListings(query: SellerListingsQuery): Promise<readonly SellerListingRow[]>;
  /** `app_private.seller_listing_create_draft(...)` (0061). */
  sellerListingCreateDraft(input: SellerListingCreateInput): Promise<SellerListingWriteResult>;
  /** `app_private.seller_listing_update_draft(...)` (0061). */
  sellerListingUpdateDraft(input: SellerListingUpdateInput): Promise<SellerListingWriteResult>;
  /** `app_private.seller_listing_submit(...)` (0061). */
  sellerListingSubmit(input: { userId: string; slug: string }): Promise<SellerListingWriteResult>;
  /** `app_private.seller_listing_archive(...)` (0061). */
  sellerListingArchive(input: { userId: string; slug: string }): Promise<SellerListingWriteResult>;
}

export const SELLER_LISTING_STORE = Symbol('SELLER_LISTING_STORE');

export interface SellerListingsPage {
  readonly listings: readonly SellerListing[];
  readonly nextCursor: string | null;
}

export interface SellerListingRef {
  readonly slug: string;
  readonly status: SellerListingStatus;
}

/** A field that was sent — with a value or as an explicit null — versus one that was not sent at all. */
function present(request: SellerListingUpdateRequest, field: keyof SellerListingUpdateRequest): boolean {
  return Object.hasOwn(request, field) && request[field] !== undefined;
}

function textOf(request: SellerListingUpdateRequest, field: 'title' | 'description'): string | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

function optionalTextOf(
  request: SellerListingUpdateRequest,
  field: 'contentLanguage' | 'currencyCode' | 'countryCode' | 'governorate' | 'city',
): string | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

@Injectable()
export class SellerListingService {
  private readonly logger = new Logger(SellerListingService.name);

  constructor(
    @Inject(SELLER_LISTING_STORE) private readonly store: SellerListingStore,
    private readonly throttle: SellerThrottleService,
  ) {}

  /**
   * One page of the caller's own listings.
   *
   * Read one row longer than asked for: if that extra row exists there is more to come, and the cursor is
   * built from the last row of the page the caller actually gets — so `nextCursor` is null exactly when the
   * page is the last one rather than one request later.
   *
   * Not throttled, deliberately. It is a read of the caller's own rows behind an authenticated session, it
   * mutates nothing and it costs one indexed query; a limit here would break a dashboard that a person is
   * merely clicking through, without denying anybody anything they could not have by other means.
   */
  async listForUser(userId: string, limit: number, cursor: string | null): Promise<SellerListingsPage> {
    const size = Math.min(Math.max(Math.trunc(limit), 1), SELLER_LISTINGS_MAX_LIMIT);

    let position: SellerListingCursor | null = null;
    if (cursor !== null) {
      position = decodeSellerListingCursor(cursor);
      if (position === null) throw new InvalidSellerListingCursorError();
    }

    let rows: readonly SellerListingRow[];
    try {
      rows = await this.store.sellerListings({
        userId,
        limit: size + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorSlug: position?.slug ?? null,
      });
    } catch (error) {
      // No detail, and nothing about the rows: a listing carries seller-written prose, a price and a
      // location, and the way to keep those out of a log is to have no line that could take them.
      this.logger.error('A seller listing page could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    const last = page.at(-1);
    return {
      listings: page.map((row) => this.#projection(row)),
      nextCursor:
        hasMore && last !== undefined ? encodeSellerListingCursor(last.createdAt, last.slug) : null,
    };
  }

  /** Creates one draft, or raises the approved refusal. */
  async createDraft(userId: string, request: SellerListingCreateRequest): Promise<SellerListingRef> {
    await this.throttle.assertCanWriteListingDraft(hashIdentifier(userId));

    const result = await this.#write('created', () =>
      this.store.sellerListingCreateDraft({
        userId,
        slug: request.slug,
        title: request.title,
        description: request.description,
        listingTypeCode: request.listingTypeCode,
        categorySlug: request.categorySlug,
        contentLanguage: request.contentLanguage,
        currencyCode: request.currencyCode,
        countryCode: request.countryCode,
        priceMinor: request.priceMinor ?? null,
        isNegotiable: request.isNegotiable ?? null,
        governorate: request.governorate ?? null,
        city: request.city ?? null,
      }),
    );
    return result;
  }

  /** Edits one draft, or raises the approved refusal. */
  async updateDraft(
    userId: string,
    slug: string,
    request: SellerListingUpdateRequest,
  ): Promise<SellerListingRef> {
    await this.throttle.assertCanWriteListingDraft(hashIdentifier(userId));

    return this.#write('updated', () =>
      this.store.sellerListingUpdateDraft({
        userId,
        slug,
        setTitle: present(request, 'title'),
        title: textOf(request, 'title'),
        setDescription: present(request, 'description'),
        description: textOf(request, 'description'),
        setPriceMinor: present(request, 'priceMinor'),
        priceMinor: request.priceMinor ?? null,
        setIsNegotiable: present(request, 'isNegotiable'),
        isNegotiable: request.isNegotiable ?? null,
        setContentLanguage: present(request, 'contentLanguage'),
        contentLanguage: optionalTextOf(request, 'contentLanguage'),
        setCurrencyCode: present(request, 'currencyCode'),
        currencyCode: optionalTextOf(request, 'currencyCode'),
        setCountryCode: present(request, 'countryCode'),
        countryCode: optionalTextOf(request, 'countryCode'),
        setGovernorate: present(request, 'governorate'),
        governorate: optionalTextOf(request, 'governorate'),
        setCity: present(request, 'city'),
        city: optionalTextOf(request, 'city'),
      }),
    );
  }

  /** Submits one draft for review, or raises the approved refusal. Its own limit, and the tighter one. */
  async submit(userId: string, slug: string): Promise<SellerListingRef> {
    await this.throttle.assertCanSubmitListing(hashIdentifier(userId));
    return this.#write('submitted', () => this.store.sellerListingSubmit({ userId, slug }));
  }

  /** Archives one live listing, or raises the approved refusal. Deletes nothing. */
  async archive(userId: string, slug: string): Promise<SellerListingRef> {
    await this.throttle.assertCanWriteListingDraft(hashIdentifier(userId));
    return this.#write('archived', () => this.store.sellerListingArchive({ userId, slug }));
  }

  /**
   * Every write, and the one place an outcome becomes an error.
   *
   * The mapping is the same for all four, because 0061 answers all four in the same vocabulary. Anything
   * outside that vocabulary is a 503 rather than a success: an outcome this service does not understand may
   * mean the database and this file have drifted, and guessing is how a refusal turns into a silent write.
   */
  async #write(
    success: string,
    run: () => Promise<SellerListingWriteResult>,
  ): Promise<SellerListingRef> {
    let result: SellerListingWriteResult;
    try {
      result = await run();
    } catch (error) {
      this.logger.error('A seller listing write could not be completed.');
      throw new SellerIdentityUnavailableError(error);
    }

    // `not_found` covers three different absences on purpose — no storefront, no such listing, and a listing
    // that is somebody else's — and they answer identically, so asking cannot reveal which it was.
    if (result.outcome === 'not_found') {
      throw success === 'created' ? new SellerProfileNotFoundError() : new SellerListingNotFoundError();
    }
    if (result.outcome === 'not_editable') {
      // A creation can only be refused this way by the storefront's own state; the other three can also be
      // refused by the listing's, and the listing's code says nothing about moderation.
      throw success === 'created'
        ? new SellerProfileNotEditableError()
        : new SellerListingNotEditableError();
    }
    if (result.outcome === 'slug_taken') throw new SellerListingSlugTakenError();
    if (result.outcome === 'incomplete') throw new SellerListingIncompleteError();
    if (result.outcome === 'invalid') throw new SellerListingInvalidError();
    if (result.outcome !== success) {
      this.logger.error('A seller listing write returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }

    const { slug, status } = result;
    if (slug === null || status === null) {
      this.logger.error('A seller listing write reported success without a row behind it.');
      throw new SellerIdentityUnavailableError(new Error('incomplete write result'));
    }
    return { slug, status: this.#status(status) };
  }

  /**
   * One row, projected onto the contract field by field.
   *
   * Explicit rather than a spread, so a column added to the database reader tomorrow cannot arrive in a
   * browser without somebody deciding it should. The statuses and types are validated rather than trusted:
   * a value the contract does not know would otherwise reach a client as a string nothing can render.
   */
  #projection(row: SellerListingRow): SellerListing {
    if (!(SELLER_LISTING_TYPES as readonly string[]).includes(row.listingTypeCode)) {
      this.logger.error('A seller listing carried a listing type this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown listing type'));
    }

    return {
      slug: row.slug,
      title: row.title,
      description: row.description,
      listingTypeCode: row.listingTypeCode as SellerListingType,
      categorySlug: row.categorySlug,
      status: this.#status(row.status),
      currencyCode: row.currencyCode,
      priceMinor: row.priceMinor,
      isNegotiable: row.isNegotiable,
      contentLanguage: row.contentLanguage,
      countryCode: row.countryCode,
      governorate: row.governorate,
      city: row.city,
      mediaCount: row.mediaCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
      archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    };
  }

  #status(status: string): SellerListingStatus {
    if (!(SELLER_LISTING_STATUSES as readonly string[]).includes(status)) {
      this.logger.error('A seller listing carried a status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown listing status'));
    }
    return status as SellerListingStatus;
  }
}
