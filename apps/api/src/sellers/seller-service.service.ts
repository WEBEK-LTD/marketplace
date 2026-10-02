import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SELLER_SERVICES_MAX_LIMIT,
  SELLER_LISTING_STATUSES,
  SELLER_SERVICE_PRICING_MODELS,
  type SellerListingStatus,
  type SellerService,
  type SellerServiceCreateRequest,
  type SellerServicePricingModel,
  type SellerServiceUpdateRequest,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  InvalidSellerListingCursorError,
  SellerIdentityUnavailableError,
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
import type { SellerListingRef, SellerListingWriteResult } from './seller-listing.service.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * The seller's own services (Phase 6-G).
 *
 * **Almost nothing here is new, and that is the design.** A service is a listing, so this service reuses
 * 6-F's cursor, 6-F's errors, 6-F's status vocabulary, 6-F's mutation response and 6-F's approved throttle
 * bucket, and the database functions it calls are themselves compositions over 6-F's. What 6-G adds is the
 * five `listing_service_details` fields and a readback that carries them.
 *
 * **There is no submit and no archive here**, because there is no second state machine: a service is
 * submitted and archived through the listing operations, which are already service-aware — 0048's exemption
 * for a service priced per engagement lives inside the submitter. A seller services surface calls those.
 *
 * **The caller names no owner, no type and no state.** `userId` is the account the API resolved from the
 * caller's own access token; it is never read from a body, a query string or a path. No database function
 * reached from here has a parameter for a seller, a listing identifier, a listing type or a status.
 *
 * **Absent and null are different requests**, and `pricingModel: null` is a third thing again: it withdraws
 * the detail row. That distinction is made in the contract and carried to the database as a set-flag and a
 * value, exactly as 6-D and 6-F carry theirs, using `Object.hasOwn` because `null` is both meaningful and
 * falsy.
 *
 * **Every write is limited before the database is touched**, against `seller_listing_draft` — 6-F's approved
 * bucket, because a service write *is* a listing draft write and inventing a second number for the same act
 * would be inventing a limit nobody approved. The limiter fails closed.
 *
 * **Nothing else happens.** Nothing is approved, activated, rejected, suspended, sold or deleted; no
 * moderation record is written; no buyer service request, quote or delivery is read or touched; no media is
 * signed. The audit trail is 0011's status-history trigger, which a detail edit does not fire because a
 * detail edit is not a transition.
 */

export interface SellerServiceRow {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly priceMinor: string | null;
  readonly isNegotiable: boolean;
  readonly contentLanguage: string;
  readonly countryCode: string;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly pricingModel: string | null;
  readonly deliveryDays: number | null;
  readonly revisionsIncluded: number | null;
  readonly requiresBrief: boolean | null;
  readonly scope: string | null;
  readonly mediaCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly submittedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface SellerServicesQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursorCreatedAt: Date | null;
  readonly cursorSlug: string | null;
}

export interface SellerServiceCreateInput {
  readonly userId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug: string;
  readonly contentLanguage: string;
  readonly currencyCode: string;
  readonly countryCode: string;
  readonly priceMinor: string | null;
  readonly isNegotiable: boolean | null;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly pricingModel: string | null;
  readonly deliveryDays: number | null;
  readonly revisionsIncluded: number | null;
  readonly requiresBrief: boolean | null;
  readonly scope: string | null;
}

export interface SellerServiceUpdateInput {
  readonly userId: string;
  readonly slug: string;
  readonly setTitle: boolean;
  readonly title: string | null;
  readonly setDescription: boolean;
  readonly description: string | null;
  readonly setPriceMinor: boolean;
  readonly priceMinor: string | null;
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
  readonly setPricingModel: boolean;
  readonly pricingModel: string | null;
  readonly setDeliveryDays: boolean;
  readonly deliveryDays: number | null;
  readonly setRevisionsIncluded: boolean;
  readonly revisionsIncluded: number | null;
  readonly setRequiresBrief: boolean;
  readonly requiresBrief: boolean | null;
  readonly setScope: boolean;
  readonly scope: string | null;
}

export interface SellerServiceStore {
  /** `app_private.seller_services(...)` (0062). */
  sellerServices(query: SellerServicesQuery): Promise<readonly SellerServiceRow[]>;
  /** `app_private.seller_service_create_draft(...)` (0062). */
  sellerServiceCreateDraft(input: SellerServiceCreateInput): Promise<SellerListingWriteResult>;
  /** `app_private.seller_service_update_draft(...)` (0062). */
  sellerServiceUpdateDraft(input: SellerServiceUpdateInput): Promise<SellerListingWriteResult>;
}

export const SELLER_SERVICE_STORE = Symbol('SELLER_SERVICE_STORE');

export interface SellerServicesPage {
  readonly services: readonly SellerService[];
  readonly nextCursor: string | null;
}

/** A field that was sent — with a value or as an explicit null — versus one that was not sent at all. */
function present(
  request: SellerServiceUpdateRequest,
  field: keyof SellerServiceUpdateRequest,
): boolean {
  return Object.hasOwn(request, field) && request[field] !== undefined;
}

function stringOf(
  request: SellerServiceUpdateRequest,
  field: 'title' | 'description' | 'priceMinor' | 'contentLanguage' | 'currencyCode' | 'countryCode'
    | 'governorate' | 'city' | 'pricingModel' | 'scope',
): string | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

function numberOf(
  request: SellerServiceUpdateRequest,
  field: 'deliveryDays' | 'revisionsIncluded',
): number | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

function booleanOf(
  request: SellerServiceUpdateRequest,
  field: 'isNegotiable' | 'requiresBrief',
): boolean | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

@Injectable()
export class SellerServiceService {
  private readonly logger = new Logger(SellerServiceService.name);

  constructor(
    @Inject(SELLER_SERVICE_STORE) private readonly store: SellerServiceStore,
    private readonly throttle: SellerThrottleService,
  ) {}

  /**
   * One page of the caller's own services.
   *
   * Read one row longer than asked for, so `nextCursor` is null exactly when the page is the last one
   * rather than one request later. Not throttled, for the reason the listings index is not: it is a read of
   * the caller's own rows behind an authenticated session and it mutates nothing.
   */
  async listForUser(userId: string, limit: number, cursor: string | null): Promise<SellerServicesPage> {
    const size = Math.min(Math.max(Math.trunc(limit), 1), SELLER_SERVICES_MAX_LIMIT);

    let position: SellerListingCursor | null = null;
    if (cursor !== null) {
      position = decodeSellerListingCursor(cursor);
      if (position === null) throw new InvalidSellerListingCursorError();
    }

    let rows: readonly SellerServiceRow[];
    try {
      rows = await this.store.sellerServices({
        userId,
        limit: size + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorSlug: position?.slug ?? null,
      });
    } catch (error) {
      // No detail, and nothing about the rows: a service carries seller-written prose, a price and a scope.
      this.logger.error('A seller service page could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    const last = page.at(-1);
    return {
      services: page.map((row) => this.#projection(row)),
      nextCursor:
        hasMore && last !== undefined ? encodeSellerListingCursor(last.createdAt, last.slug) : null,
    };
  }

  /** Creates one service draft, or raises the approved refusal. */
  async createDraft(userId: string, request: SellerServiceCreateRequest): Promise<SellerListingRef> {
    await this.throttle.assertCanWriteListingDraft(hashIdentifier(userId));

    return this.#write('created', () =>
      this.store.sellerServiceCreateDraft({
        userId,
        slug: request.slug,
        title: request.title,
        description: request.description,
        categorySlug: request.categorySlug,
        contentLanguage: request.contentLanguage,
        currencyCode: request.currencyCode,
        countryCode: request.countryCode,
        priceMinor: request.priceMinor ?? null,
        isNegotiable: request.isNegotiable ?? null,
        governorate: request.governorate ?? null,
        city: request.city ?? null,
        pricingModel: request.pricingModel ?? null,
        deliveryDays: request.deliveryDays ?? null,
        revisionsIncluded: request.revisionsIncluded ?? null,
        requiresBrief: request.requiresBrief ?? null,
        scope: request.scope ?? null,
      }),
    );
  }

  /** Edits one service draft, or raises the approved refusal. */
  async updateDraft(
    userId: string,
    slug: string,
    request: SellerServiceUpdateRequest,
  ): Promise<SellerListingRef> {
    await this.throttle.assertCanWriteListingDraft(hashIdentifier(userId));

    return this.#write('updated', () =>
      this.store.sellerServiceUpdateDraft({
        userId,
        slug,
        setTitle: present(request, 'title'),
        title: stringOf(request, 'title'),
        setDescription: present(request, 'description'),
        description: stringOf(request, 'description'),
        setPriceMinor: present(request, 'priceMinor'),
        priceMinor: stringOf(request, 'priceMinor'),
        setIsNegotiable: present(request, 'isNegotiable'),
        isNegotiable: booleanOf(request, 'isNegotiable'),
        setContentLanguage: present(request, 'contentLanguage'),
        contentLanguage: stringOf(request, 'contentLanguage'),
        setCurrencyCode: present(request, 'currencyCode'),
        currencyCode: stringOf(request, 'currencyCode'),
        setCountryCode: present(request, 'countryCode'),
        countryCode: stringOf(request, 'countryCode'),
        setGovernorate: present(request, 'governorate'),
        governorate: stringOf(request, 'governorate'),
        setCity: present(request, 'city'),
        city: stringOf(request, 'city'),
        setPricingModel: present(request, 'pricingModel'),
        pricingModel: stringOf(request, 'pricingModel'),
        setDeliveryDays: present(request, 'deliveryDays'),
        deliveryDays: numberOf(request, 'deliveryDays'),
        setRevisionsIncluded: present(request, 'revisionsIncluded'),
        revisionsIncluded: numberOf(request, 'revisionsIncluded'),
        setRequiresBrief: present(request, 'requiresBrief'),
        requiresBrief: booleanOf(request, 'requiresBrief'),
        setScope: present(request, 'scope'),
        scope: stringOf(request, 'scope'),
      }),
    );
  }

  /**
   * Every write, and the one place an outcome becomes an error.
   *
   * The vocabulary is 6-F's, because 0062's functions answer in 6-F's vocabulary — they defer to 6-F's for
   * the listing half. Anything outside it is a 503 rather than a success: an outcome this service does not
   * understand may mean the database and this file have drifted, and guessing is how a refusal turns into a
   * silent write.
   */
  async #write(
    success: 'created' | 'updated',
    run: () => Promise<SellerListingWriteResult>,
  ): Promise<SellerListingRef> {
    let result: SellerListingWriteResult;
    try {
      result = await run();
    } catch (error) {
      this.logger.error('A seller service write could not be completed.');
      throw new SellerIdentityUnavailableError(error);
    }

    // `not_found` covers four different absences on purpose — no storefront, no such listing, a listing that
    // is somebody else's, and one of the caller's own that is a product rather than a service. They answer
    // identically, so asking cannot reveal which it was.
    if (result.outcome === 'not_found') {
      throw success === 'created' ? new SellerProfileNotFoundError() : new SellerListingNotFoundError();
    }
    if (result.outcome === 'not_editable') {
      // A creation can only be refused this way by the storefront's own state; an edit can also be refused
      // by the service's, and that code says nothing about moderation.
      throw success === 'created'
        ? new SellerProfileNotEditableError()
        : new SellerListingNotEditableError();
    }
    if (result.outcome === 'slug_taken') throw new SellerListingSlugTakenError();
    if (result.outcome === 'invalid') throw new SellerListingInvalidError();
    if (result.outcome !== success) {
      this.logger.error('A seller service write returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }

    const { slug, status } = result;
    if (slug === null || status === null) {
      this.logger.error('A seller service write reported success without a row behind it.');
      throw new SellerIdentityUnavailableError(new Error('incomplete write result'));
    }
    return { slug, status: this.#status(status) };
  }

  /**
   * One row, projected onto the contract field by field.
   *
   * Explicit rather than a spread, so a column added to the database reader tomorrow cannot arrive in a
   * browser without somebody deciding it should. The status and the pricing model are validated rather than
   * trusted: a value the contract does not know would otherwise reach a client as a string nothing can
   * render.
   */
  #projection(row: SellerServiceRow): SellerService {
    let pricingModel: SellerServicePricingModel | null = null;
    if (row.pricingModel !== null) {
      if (!(SELLER_SERVICE_PRICING_MODELS as readonly string[]).includes(row.pricingModel)) {
        this.logger.error('A seller service carried a pricing model this API does not know.');
        throw new SellerIdentityUnavailableError(new Error('unknown pricing model'));
      }
      pricingModel = row.pricingModel as SellerServicePricingModel;
    }

    return {
      slug: row.slug,
      title: row.title,
      description: row.description,
      categorySlug: row.categorySlug,
      status: this.#status(row.status),
      currencyCode: row.currencyCode,
      currencyMinorUnit: row.currencyMinorUnit,
      priceMinor: row.priceMinor,
      isNegotiable: row.isNegotiable,
      contentLanguage: row.contentLanguage,
      countryCode: row.countryCode,
      governorate: row.governorate,
      city: row.city,
      pricingModel,
      deliveryDays: row.deliveryDays,
      revisionsIncluded: row.revisionsIncluded,
      requiresBrief: row.requiresBrief,
      scope: row.scope,
      mediaCount: row.mediaCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
      archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    };
  }

  #status(status: string): SellerListingStatus {
    if (!(SELLER_LISTING_STATUSES as readonly string[]).includes(status)) {
      this.logger.error('A seller service carried a status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown listing status'));
    }
    return status as SellerListingStatus;
  }
}
