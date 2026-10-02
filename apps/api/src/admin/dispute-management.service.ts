import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DisputeAuthorRole,
  DisputeDetail,
  DisputeMessage,
  DisputePartyRole,
  DisputeQueueRow,
  DisputeReasonCode,
  DisputeResolution,
  DisputeStatus,
  PostDisputeMessageResponse,
  ResolveDisputeResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  DisputeAlreadyResolvedError,
  DisputeAmountNotAllowedError,
  DisputeCursorInvalidError,
  DisputeInvalidError,
  DisputeIsPartyError,
  DisputeNotFoundError,
  DisputeReasonRequiredError,
  DisputeThreadClosedError,
  DisputeUnavailableError,
} from './dispute-management.errors.js';
import {
  decodeDisputeQueueCursor,
  encodeDisputeQueueCursor,
} from './dispute-management.cursor.js';

/**
 * Dispute management (Phase 7-R).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a dispute key — `admin` and `super_admin` — require MFA, so staff at `aal1`
 *      hold nothing at all; asking whether the effective set contains a key is therefore the AAL2 check and
 *      the permission check at once.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account and
 *      the assurance level as parameters and the key as a **literal**.
 *
 * **Two keys, and each operation requires exactly the one the database requires.** `disputes.dispute.read` for
 * the queue, the detail and the thread; `disputes.dispute.manage` for the message and the resolution — which
 * is why the detail reports `canManage` rather than leaving a screen to guess. A Moderator holds neither, by
 * the platform's own decision, and no role name is checked anywhere in this file.
 *
 * ---------------------------------------------------------------------------------------------------
 * **NOTHING IN THIS SERVICE MOVES MONEY.**
 *
 * `resolve()` records a decision. `refund_buyer` and `partial_refund` record that a refund is owed, and this
 * service creates no refund, reverses no payment, posts no ledger entry, changes no balance, touches no payout
 * or withdrawal and calls no provider. It has no store method that could: {@link DisputeManagementStore} has
 * five, and not one of them names a financial table.
 *
 * Issuing the refund is a separate, later operation with its own record and its own permission
 * (`payments.refund.*`, which this service never consults), and no writer for it exists in this platform yet.
 * ---------------------------------------------------------------------------------------------------
 *
 * **Every rule this surface appears to apply is applied in the database.** The four resolutions, the required
 * reason, the amount-only-for-a-refund rule, the refusal of a resolver who is a party, the refusal of an
 * internal note from a party, the closed thread, the order's snapshot restoration and the event that is
 * enqueued — all of it is decided inside migration 0082's wrappers, which call 0027's writers with the row
 * locked. This service passes the caller's account, translates the outcome into the approved error, and
 * **checks nothing a second time**.
 *
 * **Money crosses as a string.** The amounts arrive from the database as strings — `pg` returns `bigint` that
 * way, because a JavaScript number cannot hold one — and they leave as strings, never converted. A `Number()`
 * anywhere near one of these fields would be a precision bug waiting for a large order.
 *
 * **A refusal and an absence are the same answer.** A dispute that does not exist and a caller without the key
 * both arrive as `not_found` and become one {@link DisputeNotFoundError}.
 */

export const DISPUTES_DISPUTE_READ = 'disputes.dispute.read';
export const DISPUTES_DISPUTE_MANAGE = 'disputes.dispute.manage';

export const DISPUTE_MANAGEMENT_STORE = Symbol('DISPUTE_MANAGEMENT_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One row of `app_private.dispute_queue_for_staff` (0082).
 *
 * The two amounts are `string` because they are `bigint` in the database and `pg` hands those over as strings.
 * They are never widened to `number` anywhere in this file.
 */
export interface DisputeQueueDbRow {
  readonly id: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly currencyCode: string;
  readonly claimAmountMinor: string | null;
  readonly orderNumber: string | null;
  readonly orderStatus: string;
  readonly orderType: string;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly isParty: boolean;
  readonly resolvedByMe: boolean;
  readonly resolution: string | null;
  readonly messageCount: number | string;
  readonly hasDetails: boolean;
  readonly dueAt: Date | string | null;
  readonly createdAt: Date | string;
}

/** One row of `app_private.dispute_for_staff` (0082). */
export interface DisputeDetailDbRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly reasonCode: string | null;
  readonly details: string | null;
  readonly currencyCode: string | null;
  readonly claimAmountMinor: string | null;
  readonly orderNumber: string | null;
  readonly orderStatus: string | null;
  readonly orderType: string | null;
  readonly orderGrandTotalMinor: string | null;
  readonly orderStatusBefore: string | null;
  readonly orderPlacedAt: Date | string | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly openedByRole: string | null;
  readonly resolution: string | null;
  readonly resolutionAmountMinor: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date | string | null;
  readonly resolvedByMe: boolean | null;
  readonly isParty: boolean | null;
  readonly canManage: boolean | null;
  readonly dueAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly updatedAt: Date | string | null;
}

/** One row of `app_private.dispute_messages_for_staff` (0082). */
export interface DisputeMessageDbRow {
  readonly id: string;
  readonly authorRole: string;
  readonly body: string;
  readonly isInternal: boolean;
  readonly isOwnMessage: boolean;
  readonly createdAt: Date | string;
}

/** The single row of `app_private.dispute_message_post_for_staff` (0082). */
export interface DisputeMessagePostRow {
  readonly outcome: string;
  readonly messageId: string | null;
}

/** The single row of `app_private.dispute_resolve_for_staff` (0082). */
export interface DisputeResolveRow {
  readonly outcome: string;
  readonly status: string | null;
  readonly resolution: string | null;
}

/**
 * Three readers and two non-financial writers.
 *
 * **There is no method here that touches money.** No refund, no payment, no ledger, no balance, no payout, no
 * withdrawal, no provider. A store that could issue a refund would have to declare the method here first, and
 * there is nowhere for it to go.
 */
export interface DisputeManagementStore {
  disputeQueueForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly DisputeQueueDbRow[]>;

  disputeForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
  }): Promise<DisputeDetailDbRow>;

  disputeMessagesForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    limit: number;
  }): Promise<readonly DisputeMessageDbRow[]>;

  disputeMessagePostForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    body: string;
    isInternal: boolean;
  }): Promise<DisputeMessagePostRow>;

  disputeResolveForStaff(input: {
    userId: string;
    isAal2: boolean;
    disputeId: string;
    resolution: string;
    resolutionNote: string;
    resolutionAmountMinor: string | null;
  }): Promise<DisputeResolveRow>;
}

export interface DisputeQueuePage {
  readonly items: readonly DisputeQueueRow[];
  readonly nextCursor: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** A count is small and safe to widen. **An amount is not, and nothing below widens one.** */
function toCount(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class DisputeManagementService {
  private readonly logger = new Logger(DisputeManagementService.name);

  constructor(
    @Inject(DISPUTE_MANAGEMENT_STORE) private readonly store: DisputeManagementStore,
    private readonly console: StaffConsoleService,
  ) {}

  /**
   * One page of the dispute queue, **oldest first**.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when the page is the last
   * one rather than one request later.
   */
  async queue(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<DisputeQueuePage> {
    const staff = await this.#staff(input.accessToken, DISPUTES_DISPUTE_READ);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeDisputeQueueCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new DisputeCursorInvalidError();
    }

    let rows: readonly DisputeQueueDbRow[];
    try {
      rows = await this.store.disputeQueueForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as a parameter. The controller has already refused anything but the two reachable states, so
        // this is the value the database compares rather than a rule applied twice.
        status: input.status,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The dispute queue could not be read.');
      throw new DisputeUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        status: row.status as DisputeStatus,
        reasonCode: row.reasonCode as DisputeReasonCode,
        currencyCode: row.currencyCode,
        // Passed through as the string it arrived as. Converting it would lose precision on a large order.
        claimAmountMinor: row.claimAmountMinor,
        orderNumber: row.orderNumber ?? '',
        orderStatus: row.orderStatus,
        orderType: row.orderType as 'product' | 'service',
        sellerSlug: row.sellerSlug,
        sellerDisplayName: row.sellerDisplayName,
        isParty: row.isParty,
        resolvedByMe: row.resolvedByMe,
        resolution: row.resolution as DisputeResolution | null,
        messageCount: toCount(row.messageCount),
        hasDetails: row.hasDetails,
        dueAt: toIsoOrNull(row.dueAt),
        createdAt: toIso(row.createdAt),
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeDisputeQueueCursor({ createdAt: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One dispute, with its order. A missing one and a caller without the key are the same answer. */
  async dispute(input: { accessToken: string; disputeId: string }): Promise<DisputeDetail> {
    const staff = await this.#staff(input.accessToken, DISPUTES_DISPUTE_READ);

    let row: DisputeDetailDbRow;
    try {
      row = await this.store.disputeForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        disputeId: input.disputeId,
      });
    } catch (error) {
      this.logger.error('A dispute could not be read.');
      throw new DisputeUnavailableError(error);
    }

    if (row.outcome !== 'found') throw new DisputeNotFoundError();
    return {
      id: row.id ?? '',
      status: (row.status ?? 'open') as DisputeStatus,
      reasonCode: (row.reasonCode ?? 'other') as DisputeReasonCode,
      details: row.details,
      currencyCode: row.currencyCode ?? '',
      claimAmountMinor: row.claimAmountMinor,
      orderNumber: row.orderNumber ?? '',
      orderStatus: row.orderStatus ?? '',
      orderType: (row.orderType ?? 'product') as 'product' | 'service',
      orderGrandTotalMinor: row.orderGrandTotalMinor ?? '0',
      orderStatusBefore: row.orderStatusBefore ?? '',
      orderPlacedAt: toIsoOrNull(row.orderPlacedAt),
      sellerSlug: row.sellerSlug,
      sellerDisplayName: row.sellerDisplayName,
      openedByRole: (row.openedByRole ?? 'buyer') as DisputePartyRole,
      resolution: row.resolution as DisputeResolution | null,
      resolutionAmountMinor: row.resolutionAmountMinor,
      resolutionNote: row.resolutionNote,
      resolvedAt: toIsoOrNull(row.resolvedAt),
      resolvedByMe: row.resolvedByMe ?? false,
      isParty: row.isParty ?? false,
      canManage: row.canManage ?? false,
      dueAt: toIsoOrNull(row.dueAt),
      createdAt: toIso(row.createdAt ?? new Date(0)),
      updatedAt: toIso(row.updatedAt ?? new Date(0)),
    };
  }

  /**
   * The thread on one dispute, including the internal staff notes.
   *
   * Gated on the read key, which is what the platform gates the whole thread on for staff; it is the party's
   * own policy that hides an internal note from them, and this is not that reader.
   */
  async messages(input: {
    accessToken: string;
    disputeId: string;
    limit: number;
  }): Promise<readonly DisputeMessage[]> {
    const staff = await this.#staff(input.accessToken, DISPUTES_DISPUTE_READ);

    let rows: readonly DisputeMessageDbRow[];
    try {
      rows = await this.store.disputeMessagesForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        disputeId: input.disputeId,
        limit: input.limit,
      });
    } catch (error) {
      this.logger.error('A dispute thread could not be read.');
      throw new DisputeUnavailableError(error);
    }

    return rows.map((row) => ({
      id: row.id,
      authorRole: row.authorRole as DisputeAuthorRole,
      body: row.body,
      isInternal: row.isInternal,
      isOwnMessage: row.isOwnMessage,
      createdAt: toIso(row.createdAt),
    }));
  }

  /**
   * Adds one staff message or internal note.
   *
   * Every rule is the platform's own, applied inside the wrapper: the author's role is worked out from the
   * dispute rather than trusted, a closed thread is refused, and an internal note from a colleague who is a
   * party to the dispute is refused.
   */
  async postMessage(input: {
    accessToken: string;
    disputeId: string;
    body: string;
    isInternal: boolean;
  }): Promise<PostDisputeMessageResponse> {
    const staff = await this.#staff(input.accessToken, DISPUTES_DISPUTE_MANAGE);

    let row: DisputeMessagePostRow;
    try {
      row = await this.store.disputeMessagePostForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        disputeId: input.disputeId,
        body: input.body,
        isInternal: input.isInternal,
      });
    } catch (error) {
      this.logger.error('A dispute message could not be added.');
      throw new DisputeUnavailableError(error);
    }

    if (row.outcome !== 'posted') this.#refusal(row.outcome);
    return { outcome: 'posted', messageId: row.messageId ?? '' };
  }

  /**
   * Records a decision on one dispute.
   *
   * **This moves no money.** The writer records the decision, restores the order to the status the dispute
   * snapshotted, and enqueues its own event. No refund is created, no payment reversed, no ledger entry
   * posted, no balance changed, no payout touched and no provider called — and the response carries no refund
   * identifier or payment reference, because none exists.
   *
   * The amount is passed through as the string it arrived as, straight to a `bigint` parameter.
   */
  async resolve(input: {
    accessToken: string;
    disputeId: string;
    resolution: string;
    resolutionNote: string;
    resolutionAmountMinor: string | null;
  }): Promise<ResolveDisputeResponse> {
    const staff = await this.#staff(input.accessToken, DISPUTES_DISPUTE_MANAGE);

    let row: DisputeResolveRow;
    try {
      row = await this.store.disputeResolveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        disputeId: input.disputeId,
        resolution: input.resolution,
        resolutionNote: input.resolutionNote,
        resolutionAmountMinor: input.resolutionAmountMinor,
      });
    } catch (error) {
      this.logger.error('A dispute resolution could not be recorded.');
      throw new DisputeUnavailableError(error);
    }

    if (row.outcome !== 'resolved') this.#refusal(row.outcome);
    return {
      outcome: 'resolved',
      status: 'resolved',
      resolution: (row.resolution ?? input.resolution) as DisputeResolution,
    };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /**
   * The caller, and the one key this operation needs.
   *
   * A colleague who does not hold it is answered exactly as a missing row is. The database will apply the same
   * test again with the key as a literal, so this is the first of two rather than the only one.
   */
  async #staff(accessToken: string, permission: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new DisputeNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new DisputeNotFoundError();
    if (outcome === 'is_party') throw new DisputeIsPartyError();
    if (outcome === 'closed') throw new DisputeThreadClosedError();
    if (outcome === 'already_resolved') throw new DisputeAlreadyResolvedError();
    if (outcome === 'reason_required') throw new DisputeReasonRequiredError();
    if (outcome === 'amount_not_allowed') throw new DisputeAmountNotAllowedError();
    if (outcome === 'body_required' || outcome === 'invalid') throw new DisputeInvalidError();
    this.logger.error('A dispute operation returned an outcome this service does not understand.');
    throw new DisputeUnavailableError(new Error('unexpected outcome'));
  }
}
