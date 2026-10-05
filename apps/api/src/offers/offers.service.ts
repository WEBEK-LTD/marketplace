import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  Offer,
  OfferDecisionResponse,
  OfferMutationResponse,
  OfferStatus,
  SellerOffer,
} from '@repo/contracts';
import {
  OfferAlreadyOpenError,
  OfferBlockedError,
  OfferLapsedError,
  OfferNotActionableError,
  OfferNotAvailableError,
  OfferNotFoundError,
  OfferOwnListingError,
  OfferPaymentPolicyMissingError,
  OffersCursorInvalidError,
  OffersUnavailableError,
} from './offers.errors.js';
import { decodeOffersCursor, encodeOffersCursor } from './offers-cursor.js';

/**
 * Offers: negotiation and acceptance (Phase 7-H).
 *
 * **Every rule this surface appears to apply is applied in the database.** Whether a listing may be
 * offered on, whether the caller already has a live offer, whether the pair is blocked, whether an offer
 * is the caller's and on which side, whether it is still live, whether its window has passed, and what the
 * payment deadline is — all of it is decided inside a SECURITY DEFINER function in migration 0070, with
 * the row locked. This service passes the caller's own account, translates the outcome into the approved
 * error, and **checks nothing a second time**: a second copy of an authorization or state rule is how two
 * copies start to disagree, and here the second copy would be the one without the lock.
 *
 * **No method takes a party, a status, or a deadline.** The caller's account arrives from their own token
 * through {@link CurrentUserService}; the operations are named transitions rather than status assignments;
 * and `payment_due_at` is not a parameter of anything in this file. There is no arrangement of inputs that
 * could make somebody act on an offer they are not a party to, or set a deadline of their own choosing.
 *
 * **Acceptance records an obligation and hands off.** It creates no order, no checkout, no reservation, no
 * payment, no ledger entry and no payout, and it calls no provider. Phase 8 consumes the accepted offer
 * later; nothing here anticipates it.
 *
 * **No notification and no event.** The repository defines no offer notification event type, template key
 * or writer, and the only offer event anywhere is the scheduled sweeper's own `offer.expired`. Inventing a
 * second would be inventing user-facing semantics, so this increment emits none and reports the gap.
 *
 * **Nothing here logs a value.** An offer is a price two people are negotiating. The log lines below carry
 * a sentence and no amount, no identifier and no account.
 */

export interface OfferRow {
  readonly id: string;
  readonly listingId: string;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly amountMinor: string | number | bigint | null;
  readonly currencyCode: string | null;
  readonly currencyMinorUnit: number | null;
  readonly quantity: number | null;
  readonly message: string | null;
  readonly status: string;
  readonly isLapsed: boolean | null;
  readonly expiresAt: Date | string | null;
  readonly respondedAt: Date | string | null;
  readonly acceptedAt: Date | string | null;
  readonly paymentDueAt: Date | string | null;
  readonly parentOfferId: string | null;
  readonly createdAt: Date | string | null;
}

export interface SellerOfferRow extends Omit<OfferRow, 'sellerSlug' | 'sellerDisplayName'> {
  readonly buyerDisplayName: string | null;
}

export interface OfferMutationRow {
  readonly outcome: string;
  readonly offerId: string | null;
  readonly status: string | null;
}

export interface OfferDecisionRow {
  readonly outcome: string;
  readonly status: string | null;
  readonly acceptedAt: Date | string | null;
  readonly paymentDueAt: Date | string | null;
}

export interface OffersStore {
  /** `app_private.offers_for_buyer(...)` (0070). */
  offersForBuyer(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly OfferRow[]>;
  /** `app_private.offers_for_seller(...)` (0070). */
  offersForSeller(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SellerOfferRow[]>;
  /** `app_private.offer_create(...)` (0070). */
  offerCreate(input: {
    buyerId: string;
    listingId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationRow>;
  /** `app_private.offer_counter(...)` (0070). */
  offerCounter(input: {
    buyerId: string;
    parentOfferId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationRow>;
  /** `app_private.offer_accept(uuid, uuid)` (0070). */
  offerAccept(input: { sellerId: string; offerId: string }): Promise<OfferDecisionRow>;
  /** `app_private.offer_reject(uuid, uuid)` (0070). */
  offerReject(input: { sellerId: string; offerId: string }): Promise<OfferDecisionRow>;
  /** `app_private.offer_withdraw(uuid, uuid)` (0070). */
  offerWithdraw(input: { buyerId: string; offerId: string }): Promise<OfferDecisionRow>;
}

export const OFFERS_STORE = Symbol('OFFERS_STORE');

@Injectable()
export class OffersService {
  private readonly logger = new Logger(OffersService.name);

  constructor(@Inject(OFFERS_STORE) private readonly store: OffersStore) {}

  /** One page of the offers the caller has made. */
  async made(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: Offer[]; nextCursor: string | null }> {
    const position = this.#position(input.cursor);

    let rows: readonly OfferRow[];
    try {
      rows = await this.store.offersForBuyer({
        userId: input.userId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The offers a buyer has made could not be read.');
      throw new OffersUnavailableError(error);
    }

    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({
        ...this.#core(row),
        sellerSlug: this.#text(row.sellerSlug, 'sellerSlug'),
        sellerDisplayName: this.#text(row.sellerDisplayName, 'sellerDisplayName'),
      })),
      nextCursor: this.#next(rows, page, input.limit),
    };
  }

  /** One page of the offers made to the caller's storefront. */
  async received(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: SellerOffer[]; nextCursor: string | null }> {
    const position = this.#position(input.cursor);

    let rows: readonly SellerOfferRow[];
    try {
      rows = await this.store.offersForSeller({
        userId: input.userId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The offers a seller has received could not be read.');
      throw new OffersUnavailableError(error);
    }

    const page = rows.slice(0, input.limit);
    return {
      items: page.map((row) => ({ ...this.#core(row), buyerDisplayName: row.buyerDisplayName })),
      nextCursor: this.#next(rows, page, input.limit),
    };
  }

  /** Opens one offer, as the buyer. */
  async create(input: {
    userId: string;
    listingId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationResponse> {
    let row: OfferMutationRow;
    try {
      row = await this.store.offerCreate({
        buyerId: input.userId,
        listingId: input.listingId,
        amountMinor: input.amountMinor,
        quantity: input.quantity,
        message: input.message,
      });
    } catch (error) {
      this.logger.error('An offer could not be opened.');
      throw new OffersUnavailableError(error);
    }
    return this.#mutation(row, 'created');
  }

  /** Replaces the caller's own live offer with a new one. */
  async counter(input: {
    userId: string;
    offerId: string;
    amountMinor: string;
    quantity: number;
    message: string | null;
  }): Promise<OfferMutationResponse> {
    let row: OfferMutationRow;
    try {
      row = await this.store.offerCounter({
        buyerId: input.userId,
        parentOfferId: input.offerId,
        amountMinor: input.amountMinor,
        quantity: input.quantity,
        message: input.message,
      });
    } catch (error) {
      this.logger.error('An offer could not be countered.');
      throw new OffersUnavailableError(error);
    }
    return this.#mutation(row, 'countered');
  }

  /**
   * The seller accepts.
   *
   * The obligation fields come back from the one statement that wrote them, so what this reports is what
   * the row holds rather than what this process recomputed.
   */
  async accept(input: { userId: string; offerId: string }): Promise<OfferDecisionResponse> {
    let row: OfferDecisionRow;
    try {
      row = await this.store.offerAccept({ sellerId: input.userId, offerId: input.offerId });
    } catch (error) {
      this.logger.error('An offer could not be accepted.');
      throw new OffersUnavailableError(error);
    }
    return this.#decision(row, 'accepted');
  }

  /** The seller declines. */
  async reject(input: { userId: string; offerId: string }): Promise<OfferDecisionResponse> {
    let row: OfferDecisionRow;
    try {
      row = await this.store.offerReject({ sellerId: input.userId, offerId: input.offerId });
    } catch (error) {
      this.logger.error('An offer could not be rejected.');
      throw new OffersUnavailableError(error);
    }
    return this.#decision(row, 'rejected');
  }

  /** The buyer takes their own offer back. */
  async withdraw(input: { userId: string; offerId: string }): Promise<OfferDecisionResponse> {
    let row: OfferDecisionRow;
    try {
      row = await this.store.offerWithdraw({ buyerId: input.userId, offerId: input.offerId });
    } catch (error) {
      this.logger.error('An offer could not be withdrawn.');
      throw new OffersUnavailableError(error);
    }
    return this.#decision(row, 'withdrawn');
  }

  /* ------------------------------------------------------------------------------------------------ */

  #position(cursor: string | null): { createdAt: Date; id: string } | null {
    if (cursor === null) return null;
    const position = decodeOffersCursor(cursor);
    // One refusal for malformed, altered and outdated. Paging silently from the beginning would repeat
    // rows somebody had already worked through.
    if (position === null) throw new OffersCursorInvalidError();
    return position;
  }

  #next(
    rows: readonly { id: string; createdAt: Date | string | null }[],
    page: readonly { id: string; createdAt: Date | string | null }[],
    limit: number,
  ): string | null {
    if (rows.length <= limit) return null;
    const last = page.at(-1);
    if (last === undefined || last.createdAt === null) return null;
    return encodeOffersCursor({ createdAt: toDate(last.createdAt), id: last.id });
  }

  /**
   * One offer's shared fields, projected field by field.
   *
   * Written out rather than spread, for the same reason 6-I's and 7-G's readbacks are: a projection that
   * names its fields cannot acquire an account identifier if somebody later widens the function's result,
   * and a spread would have carried one outward silently.
   */
  #core(row: OfferRow | SellerOfferRow): Omit<Offer, 'sellerSlug' | 'sellerDisplayName'> {
    if (
      row.amountMinor === null ||
      row.currencyCode === null ||
      row.currencyMinorUnit === null ||
      row.quantity === null ||
      row.expiresAt === null ||
      row.createdAt === null ||
      row.isLapsed === null ||
      row.listingSlug === null ||
      row.listingTitle === null
    ) {
      this.logger.error('An offer came back incomplete.');
      throw new OffersUnavailableError(new Error('incomplete offer'));
    }
    return {
      id: row.id,
      listingId: row.listingId,
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      // `bigint` crosses the wire as a string and stays one: a JSON number would be a precision decision
      // nobody made.
      amountMinor: String(row.amountMinor),
      currencyCode: row.currencyCode,
      currencyMinorUnit: row.currencyMinorUnit,
      quantity: row.quantity,
      message: row.message,
      status: row.status as OfferStatus,
      isLapsed: row.isLapsed,
      expiresAt: toIso(row.expiresAt),
      respondedAt: toIsoOrNull(row.respondedAt),
      acceptedAt: toIsoOrNull(row.acceptedAt),
      paymentDueAt: toIsoOrNull(row.paymentDueAt),
      parentOfferId: row.parentOfferId,
      createdAt: toIso(row.createdAt),
    };
  }

  #text(value: string | null, field: string): string {
    if (value === null) {
      this.logger.error('An offer came back without a field the contract requires.');
      throw new OffersUnavailableError(new Error(`incomplete offer: ${field}`));
    }
    return value;
  }

  /**
   * The outcomes `offer_create` and `offer_counter` share.
   *
   * `not_found` covers a listing or an offer that does not exist **and** one that is not the caller's, and
   * the two are deliberately the same answer.
   */
  #mutation(row: OfferMutationRow, success: 'created' | 'countered'): OfferMutationResponse {
    if (row.outcome === success) {
      if (row.offerId === null || row.status === null) {
        this.logger.error('An offer write came back incomplete.');
        throw new OffersUnavailableError(new Error('incomplete offer write'));
      }
      return { offerId: row.offerId, status: row.status as OfferStatus };
    }
    this.#refusal(row.outcome);
  }

  /** The outcomes the three decisions share. */
  #decision(
    row: OfferDecisionRow,
    success: 'accepted' | 'rejected' | 'withdrawn',
  ): OfferDecisionResponse {
    if (row.outcome === success) {
      if (row.status === null) {
        this.logger.error('An offer decision came back without a status.');
        throw new OffersUnavailableError(new Error('incomplete offer decision'));
      }
      return {
        status: row.status as OfferStatus,
        acceptedAt: toIsoOrNull(row.acceptedAt),
        paymentDueAt: toIsoOrNull(row.paymentDueAt),
      };
    }
    this.#refusal(row.outcome);
  }

  /** Every outcome 0070 can return that is not a success, in one place. */
  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new OfferNotFoundError();
    if (outcome === 'invalid') throw new OfferNotFoundError();
    if (outcome === 'exists') throw new OfferAlreadyOpenError();
    if (outcome === 'not_available') throw new OfferNotAvailableError();
    if (outcome === 'own_listing') throw new OfferOwnListingError();
    if (outcome === 'blocked') throw new OfferBlockedError();
    if (outcome === 'conflict') throw new OfferNotActionableError();
    if (outcome === 'expired') throw new OfferLapsedError();
    if (outcome === 'payment_policy_missing') throw new OfferPaymentPolicyMissingError();
    this.logger.error('An offer operation returned an outcome this service does not understand.');
    throw new OffersUnavailableError(new Error('unexpected outcome'));
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
