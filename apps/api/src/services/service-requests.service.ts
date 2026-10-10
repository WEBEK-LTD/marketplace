import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ServiceQuote,
  ServiceQuoteDecisionResponse,
  ServiceQuoteStatus,
  ServiceRequestDetail,
  ServiceRequestMutationResponse,
  ServiceRequestRoutingMode,
  ServiceRequestStatus,
  ServiceRequestStatusResponse,
  ServiceRequestSummary,
} from '@repo/contracts';
import {
  ServiceQuoteLapsedError,
  ServiceQuotePaymentPolicyMissingError,
  ServiceRequestBlockedError,
  ServiceRequestCurrencyUnavailableError,
  ServiceRequestNotActionableError,
  ServiceRequestNotAvailableError,
  ServiceRequestNotCustomError,
  ServiceRequestNotFoundError,
  ServiceRequestOwnListingError,
  ServiceRequestsCursorInvalidError,
  ServiceRequestsUnavailableError,
} from './service-requests.errors.js';
import {
  decodeServiceRequestsCursor,
  encodeServiceRequestsCursor,
} from './service-requests-cursor.js';

/**
 * Service requests and quotes — Option 1 (Phase 7-I).
 *
 * **Every rule this surface appears to apply is applied in the database.** Whether a service can be briefed,
 * whether it is custom-priced, whether the pair is blocked, whether a request or a quote is the caller's and
 * on which side, whether either is still live, whether a quote's window has passed, and what the payment
 * deadline is — all of it is decided inside a SECURITY DEFINER function in migration 0071, with the rows
 * locked. This service passes the caller's own account, translates the outcome into the approved error, and
 * **checks nothing a second time**: a second copy of an authorization or state rule is how two copies start
 * to disagree, and here the second copy would be the one without the lock.
 *
 * **No method takes a party, a status, a currency or a deadline.** The caller's account arrives from their own
 * token through {@link CurrentUserService}; the operations are named transitions; and `payment_due_at` is not
 * a parameter of anything in this file.
 *
 * **A quote must belong to the request that addressed it.** Each quote writer reports which request its quote
 * belongs to, and this service refuses a mismatch as a plain not-found — so a quote identifier cannot be spent
 * from the wrong page.
 *
 * **Acceptance records an obligation and hands off.** It creates no order, no checkout, no delivery row, no
 * payment, no ledger entry and no payout, and it calls no provider. Phase 8 consumes the accepted quote later.
 *
 * **No notification and no event.** The repository defines no service-request or service-quote notification
 * event type, template key or writer, and the only event that exists is the scheduled sweeper's own
 * `service_quote.expired`. Inventing a second would be inventing user-facing semantics.
 *
 * **Option 2 is nowhere in this file.** There is no routing, staff or admin path here, because there is no
 * routing column in the schema for one.
 *
 * **Nothing here logs a value.** A brief is somebody's project and a quote is a price. The log lines below
 * carry a sentence and no amount, no identifier and no account.
 */

export interface ServiceRequestRow {
  readonly id: string;
  readonly status: string;
  readonly routingMode: string | null;
  readonly title: string | null;
  readonly budgetMinor: string | number | bigint | null;
  readonly currencyCode: string | null;
  readonly currencyMinorUnit: number | null;
  readonly neededBy: Date | string | null;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly counterpartyName: string | null;
  readonly quoteCount: number | null;
  readonly liveQuoteCount: number | null;
  readonly acceptedPaymentDueAt: Date | string | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

export interface ServiceRequestDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly routingMode: string | null;
  readonly isBuyer: boolean | null;
  readonly isSeller: boolean | null;
  readonly title: string | null;
  readonly brief: string | null;
  readonly budgetMinor: string | number | bigint | null;
  readonly currencyCode: string | null;
  readonly currencyMinorUnit: number | null;
  readonly neededBy: Date | string | null;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly buyerName: string | null;
  readonly sellerSlug: string | null;
  readonly sellerName: string | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly quotes: unknown;
}

export interface ServiceRequestMutationRow {
  readonly outcome: string;
  readonly requestId: string | null;
  readonly status: string | null;
}

export interface ServiceRequestStatusRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface ServiceQuoteMutationRow {
  readonly outcome: string;
  readonly quoteId: string | null;
  readonly status: string | null;
}

export interface ServiceQuoteDecisionRow {
  readonly outcome: string;
  readonly status: string | null;
  readonly requestId: string | null;
  readonly acceptedAt: Date | string | null;
  readonly paymentDueAt: Date | string | null;
}

export interface ServiceRequestsStore {
  /** `app_private.service_requests_for_buyer(...)` (0071). */
  serviceRequestsForBuyer(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ServiceRequestRow[]>;
  /** `app_private.service_request_detail(uuid, uuid)` (0071). */
  serviceRequestDetail(input: {
    userId: string;
    requestId: string;
  }): Promise<ServiceRequestDetailRow>;
  /** `app_private.service_request_create(...)` (0071). */
  serviceRequestCreate(input: {
    buyerId: string;
    listingId: string;
    title: string;
    brief: string;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationRow>;
  /** `app_private.service_request_create_admin_only(...)` (0073). */
  serviceRequestCreateAdminOnly(input: {
    buyerId: string;
    title: string;
    brief: string;
    preferredPaymentMethod: string;
    paymentNotes: string | null;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationRow>;
  /** `app_private.service_request_cancel(uuid, uuid)` (0071). */
  serviceRequestCancel(input: { buyerId: string; requestId: string }): Promise<ServiceRequestStatusRow>;
}

export const SERVICE_REQUESTS_STORE = Symbol('SERVICE_REQUESTS_STORE');

@Injectable()
export class ServiceRequestsService {
  private readonly logger = new Logger(ServiceRequestsService.name);

  constructor(@Inject(SERVICE_REQUESTS_STORE) private readonly store: ServiceRequestsStore) {}

  /** One page of the briefs the caller has sent. */
  async made(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ServiceRequestSummary[]; nextCursor: string | null }> {
    return await this.#page(input, (query) => this.store.serviceRequestsForBuyer(query), 'sent');
  }

  /** One brief in full, with its quotes, for whichever party is asking. */
  async detail(input: { userId: string; requestId: string }): Promise<ServiceRequestDetail> {
    let row: ServiceRequestDetailRow;
    try {
      row = await this.store.serviceRequestDetail(input);
    } catch (error) {
      this.logger.error('A service request could not be read.');
      throw new ServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new ServiceRequestNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A service request read returned an outcome this service does not understand.');
      throw new ServiceRequestsUnavailableError(new Error('unexpected outcome'));
    }
    if (
      row.id === null ||
      row.status === null ||
      row.routingMode === null ||
      row.isBuyer === null ||
      row.isSeller === null ||
      row.title === null ||
      row.brief === null ||
      row.currencyCode === null ||
      row.currencyMinorUnit === null ||
      row.createdAt === null
    ) {
      this.logger.error('A service request came back incomplete.');
      throw new ServiceRequestsUnavailableError(new Error('incomplete service request'));
    }

    return {
      id: row.id,
      status: row.status as ServiceRequestStatus,
      routingMode: row.routingMode as ServiceRequestRoutingMode,
      isBuyer: row.isBuyer,
      isSeller: row.isSeller,
      title: row.title,
      brief: row.brief,
      budgetMinor: amountOrNull(row.budgetMinor),
      currencyCode: row.currencyCode,
      currencyMinorUnit: row.currencyMinorUnit,
      neededBy: dateOrNull(row.neededBy),
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      buyerName: row.buyerName,
      sellerSlug: row.sellerSlug,
      sellerName: row.sellerName,
      closedAt: toIsoOrNull(row.closedAt),
      createdAt: toIso(row.createdAt),
      quotes: this.#projectQuotes(row.quotes),
    };
  }

  /** Sends one brief. */
  async create(input: {
    userId: string;
    listingId: string;
    title: string;
    brief: string;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationResponse> {
    let row: ServiceRequestMutationRow;
    try {
      row = await this.store.serviceRequestCreate({
        buyerId: input.userId,
        listingId: input.listingId,
        title: input.title,
        brief: input.brief,
        budgetMinor: input.budgetMinor,
        neededBy: input.neededBy,
      });
    } catch (error) {
      this.logger.error('A service request could not be sent.');
      throw new ServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'created') {
      if (row.requestId === null || row.status === null) {
        this.logger.error('A service request write came back incomplete.');
        throw new ServiceRequestsUnavailableError(new Error('incomplete service request write'));
      }
      return { requestId: row.requestId, status: row.status as ServiceRequestStatus };
    }
    this.#refusal(row.outcome);
  }

  /**
   * Sends one Admin Only brief (Phase 7-J).
   *
   * A separate method rather than a mode argument on {@link create}, for the reason the two list readers are
   * separate: **the caller cannot choose the flow.** The database writes the routing mode and the null seller
   * as literals and takes the currency from the platform's own default; nothing about either reaches this
   * method, and there is no parameter here that could.
   *
   * It creates no quote, invokes no quote path, and writes no notification — the repository defines no
   * service-request notification event, so there is nothing to call and nothing suppressed.
   */
  async createAdminOnly(input: {
    userId: string;
    title: string;
    brief: string;
    preferredPaymentMethod: string;
    paymentNotes: string | null;
    budgetMinor: string | null;
    neededBy: string | null;
  }): Promise<ServiceRequestMutationResponse> {
    let row: ServiceRequestMutationRow;
    try {
      row = await this.store.serviceRequestCreateAdminOnly({
        buyerId: input.userId,
        title: input.title,
        brief: input.brief,
        preferredPaymentMethod: input.preferredPaymentMethod,
        paymentNotes: input.paymentNotes,
        budgetMinor: input.budgetMinor,
        neededBy: input.neededBy,
      });
    } catch (error) {
      this.logger.error('An Admin Only service request could not be sent.');
      throw new ServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'created') {
      if (row.requestId === null || row.status === null) {
        this.logger.error('An Admin Only service request write came back incomplete.');
        throw new ServiceRequestsUnavailableError(new Error('incomplete service request write'));
      }
      return { requestId: row.requestId, status: row.status as ServiceRequestStatus };
    }
    this.#refusal(row.outcome);
  }

  /** The buyer withdraws their own brief. */
  async cancel(input: { userId: string; requestId: string }): Promise<ServiceRequestStatusResponse> {
    return await this.#requestStatus(
      () => this.store.serviceRequestCancel({ buyerId: input.userId, requestId: input.requestId }),
      'cancelled',
      'A service request could not be cancelled.',
    );
  }

  /* ------------------------------------------------------------------------------------------------ */

  async #page(
    input: { userId: string; limit: number; cursor: string | null },
    read: (query: {
      userId: string;
      limit: number;
      cursorCreatedAt: Date | null;
      cursorId: string | null;
    }) => Promise<readonly ServiceRequestRow[]>,
    side: 'sent' | 'received',
  ): Promise<{ items: ServiceRequestSummary[]; nextCursor: string | null }> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeServiceRequestsCursor(input.cursor);
      // One refusal for malformed, altered and outdated. Paging silently from the beginning would repeat
      // rows somebody had already worked through.
      if (position === null) throw new ServiceRequestsCursorInvalidError();
    }

    let rows: readonly ServiceRequestRow[];
    try {
      rows = await read({
        userId: input.userId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error(`The service requests a caller has ${side} could not be read.`);
      throw new ServiceRequestsUnavailableError(error);
    }

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined && last.createdAt !== null
        ? encodeServiceRequestsCursor({ createdAt: toDate(last.createdAt), id: last.id })
        : null;

    return { items: page.map((row) => this.#summary(row)), nextCursor };
  }

  async #requestStatus(
    write: () => Promise<ServiceRequestStatusRow>,
    success: 'cancelled' | 'declined',
    failure: string,
  ): Promise<ServiceRequestStatusResponse> {
    let row: ServiceRequestStatusRow;
    try {
      row = await write();
    } catch (error) {
      this.logger.error(failure);
      throw new ServiceRequestsUnavailableError(error);
    }

    if (row.outcome === success) {
      if (row.status === null) {
        this.logger.error('A service request write came back without a status.');
        throw new ServiceRequestsUnavailableError(new Error('incomplete service request write'));
      }
      return { status: row.status as ServiceRequestStatus };
    }
    this.#refusal(row.outcome);
  }

  /**
   * One quote decision.
   *
   * The request in the route and the request the database says the quote belongs to must agree; a mismatch
   * is absence, like every other wrong-context answer on this surface. The check is made **after** the write
   * has been refused or performed, which is safe because the database has already scoped the write to the
   * caller's own side — a mismatch here can only be a client naming the wrong page, never an authorization
   * decision this layer is making.
   */
  async #quoteDecision(
    write: () => Promise<ServiceQuoteDecisionRow>,
    success: 'accepted' | 'rejected' | 'withdrawn',
    requestId: string,
    failure: string,
  ): Promise<ServiceQuoteDecisionResponse> {
    let row: ServiceQuoteDecisionRow;
    try {
      row = await write();
    } catch (error) {
      this.logger.error(failure);
      throw new ServiceRequestsUnavailableError(error);
    }

    if (row.requestId !== null && row.requestId !== requestId) throw new ServiceRequestNotFoundError();

    if (row.outcome === success) {
      if (row.status === null) {
        this.logger.error('A service quote decision came back without a status.');
        throw new ServiceRequestsUnavailableError(new Error('incomplete service quote decision'));
      }
      return {
        status: row.status as ServiceQuoteStatus,
        acceptedAt: toIsoOrNull(row.acceptedAt),
        paymentDueAt: toIsoOrNull(row.paymentDueAt),
      };
    }
    this.#refusal(row.outcome);
  }

  #summary(row: ServiceRequestRow): ServiceRequestSummary {
    if (
      row.routingMode === null ||
      row.title === null ||
      row.currencyCode === null ||
      row.currencyMinorUnit === null ||
      row.quoteCount === null ||
      row.liveQuoteCount === null ||
      row.createdAt === null
    ) {
      this.logger.error('A service request row came back incomplete.');
      throw new ServiceRequestsUnavailableError(new Error('incomplete service request row'));
    }
    return {
      id: row.id,
      status: row.status as ServiceRequestStatus,
      routingMode: row.routingMode as ServiceRequestRoutingMode,
      title: row.title,
      budgetMinor: amountOrNull(row.budgetMinor),
      currencyCode: row.currencyCode,
      currencyMinorUnit: row.currencyMinorUnit,
      neededBy: dateOrNull(row.neededBy),
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      counterpartyName: row.counterpartyName,
      quoteCount: row.quoteCount,
      liveQuoteCount: row.liveQuoteCount,
      acceptedPaymentDueAt: toIsoOrNull(row.acceptedPaymentDueAt),
      closedAt: toIsoOrNull(row.closedAt),
      createdAt: toIso(row.createdAt),
    };
  }

  /**
   * The quotes, projected field by field.
   *
   * Written out rather than spread, for the same reason every other readback in this project is: a projection
   * that names its fields cannot acquire an account identifier if somebody later widens the function's
   * `jsonb`, and a spread would have carried one outward silently.
   */
  #projectQuotes(raw: unknown): ServiceQuote[] {
    if (!Array.isArray(raw)) return [];
    const quotes: ServiceQuote[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row['id'] === 'string' ? row['id'] : null;
      const status = typeof row['status'] === 'string' ? row['status'] : null;
      const amountMinor = typeof row['amountMinor'] === 'string' ? row['amountMinor'] : null;
      const scope = typeof row['scope'] === 'string' ? row['scope'] : null;
      const expiresAt = row['expiresAt'];
      const createdAt = row['createdAt'];
      if (
        id === null ||
        status === null ||
        amountMinor === null ||
        scope === null ||
        typeof row['deliveryDays'] !== 'number' ||
        typeof row['revisionsIncluded'] !== 'number' ||
        typeof row['isLapsed'] !== 'boolean' ||
        (typeof expiresAt !== 'string' && !(expiresAt instanceof Date)) ||
        (typeof createdAt !== 'string' && !(createdAt instanceof Date))
      ) {
        this.logger.error('A service quote came back in a shape this service does not project.');
        throw new ServiceRequestsUnavailableError(new Error('incomplete service quote'));
      }
      quotes.push({
        id,
        status: status as ServiceQuoteStatus,
        amountMinor,
        deliveryDays: row['deliveryDays'],
        revisionsIncluded: row['revisionsIncluded'],
        scope,
        isLapsed: row['isLapsed'],
        expiresAt: toIso(expiresAt),
        respondedAt: timestampOrNull(row['respondedAt']),
        acceptedAt: timestampOrNull(row['acceptedAt']),
        paymentDueAt: timestampOrNull(row['paymentDueAt']),
        createdAt: toIso(createdAt),
      });
    }
    return quotes;
  }

  /** Every outcome 0071 can return that is not a success, in one place. */
  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new ServiceRequestNotFoundError();
    if (outcome === 'invalid') throw new ServiceRequestNotFoundError();
    if (outcome === 'not_available') throw new ServiceRequestNotAvailableError();
    if (outcome === 'not_custom') throw new ServiceRequestNotCustomError();
    if (outcome === 'own_listing') throw new ServiceRequestOwnListingError();
    if (outcome === 'blocked') throw new ServiceRequestBlockedError();
    if (outcome === 'conflict') throw new ServiceRequestNotActionableError();
    if (outcome === 'expired') throw new ServiceQuoteLapsedError();
    if (outcome === 'payment_policy_missing') throw new ServiceQuotePaymentPolicyMissingError();
    if (outcome === 'no_currency') throw new ServiceRequestCurrencyUnavailableError();
    this.logger.error('A service request operation returned an outcome this service does not understand.');
    throw new ServiceRequestsUnavailableError(new Error('unexpected outcome'));
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string): string {
  return toDate(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value === 'string') return toIso(value);
  if (value instanceof Date) return value.toISOString();
  return null;
}

/** A `bigint` amount stays a decimal string: a JSON number would be a precision decision nobody made. */
function amountOrNull(value: string | number | bigint | null): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A `date` column, as `YYYY-MM-DD`. No time and no zone travels with it. */
function dateOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}
