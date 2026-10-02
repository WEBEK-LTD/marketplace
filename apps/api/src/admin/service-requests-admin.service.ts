import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AdminServiceRequestDecisionResponse,
  AdminServiceRequestDetail,
  AdminServiceRequestSummary,
  ServiceRequestPaymentInformation,
  ServiceRequestStatus,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  AdminServiceRequestNotActionableError,
  AdminServiceRequestNotFoundError,
  AdminServiceRequestsCursorInvalidError,
  AdminServiceRequestsUnavailableError,
} from './service-requests-admin.errors.js';
import {
  ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION,
  ADMIN_SERVICE_REQUEST_READ_PERMISSION,
  SERVICE_REQUEST_PAYMENT_INFO_PERMISSION,
  decodeAdminServiceRequestsCursor,
  encodeAdminServiceRequestsCursor,
} from './service-requests-admin.cursor.js';

/**
 * The staff side of Admin Only service requests — Option 2 (Phase 7-J).
 *
 * **Authorization, in the one order it is ever done**, which is 7-G's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      Because every console role requires MFA, staff at `aal1` hold no permission at all — so asking whether
 *      the effective set contains a key is simultaneously the AAL2 check and the permission check, and there
 *      is no separate assurance test here that could be forgotten on one route.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account and
 *      the assurance level as parameters. No bug in this file can turn into somebody's brief.
 *
 * **No role name appears in any decision this file makes.** The four staff roles exist in the contract, but
 * nothing here branches on one: authorization is the permission key and only the permission key, exactly as it
 * is in the database. That is what makes "a moderator cannot read payment information" true — they hold the
 * key nowhere, not because a list of role names excludes them.
 *
 * **Three keys, and they are not interchangeable.**
 *
 *   * `service_requests.request.read` — the queue and the detail.
 *   * `service_requests.payment_info.read` — the two descriptive payment fields, **and nothing else**.
 *   * `service_requests.request.manage` — the one approved closure.
 *
 * **The payment fields are a different document, not a different branch.** A caller holding only the request
 * key never reaches a statement that mentions them: the detail's own database function does not select either
 * column, and the response shape has no field for them. There is nothing here to forget to hide.
 *
 * **Nothing here logs a value.** A brief is somebody's project and the payment fields are how they want to pay.
 * The log lines below carry a sentence and no identifier, no account and no value.
 */

export interface AdminServiceRequestRow {
  readonly id: string;
  readonly status: string;
  readonly title: string | null;
  readonly budgetMinor: string | number | bigint | null;
  readonly currencyCode: string | null;
  readonly currencyMinorUnit: number | null;
  readonly neededBy: Date | string | null;
  readonly buyerName: string | null;
  readonly hasPaymentNotes: boolean | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly updatedAt: Date | string | null;
}

export interface AdminServiceRequestDetailRow extends AdminServiceRequestRow {
  readonly outcome: string;
  readonly brief: string | null;
}

export interface ServiceRequestPaymentInformationRow {
  readonly outcome: string;
  readonly preferredPaymentMethod: string | null;
  readonly paymentNotes: string | null;
}

export interface AdminServiceRequestDecisionRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface AdminServiceRequestsStore {
  /** `app_private.service_requests_admin_only_queue(...)` (0073). */
  serviceRequestsAdminOnlyQueue(input: {
    userId: string;
    isAal2: boolean;
    status: string | null;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly AdminServiceRequestRow[]>;
  /** `app_private.service_request_admin_only_detail(uuid, boolean, uuid)` (0073). */
  serviceRequestAdminOnlyDetail(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<AdminServiceRequestDetailRow>;
  /** `app_private.service_request_payment_information(uuid, boolean, uuid)` (0073). */
  serviceRequestPaymentInformation(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<ServiceRequestPaymentInformationRow>;
  /** `app_private.service_request_admin_decline(uuid, boolean, uuid)` (0073). */
  serviceRequestAdminDecline(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<AdminServiceRequestDecisionRow>;
}

export const ADMIN_SERVICE_REQUESTS_STORE = Symbol('ADMIN_SERVICE_REQUESTS_STORE');

@Injectable()
export class AdminServiceRequestsService {
  private readonly logger = new Logger(AdminServiceRequestsService.name);

  constructor(
    private readonly console: StaffConsoleService,
    @Inject(ADMIN_SERVICE_REQUESTS_STORE) private readonly store: AdminServiceRequestsStore,
  ) {}

  /** One page of the queue, oldest first. */
  async queue(input: {
    accessToken: string;
    status: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: AdminServiceRequestSummary[]; nextCursor: string | null }> {
    const staff = await this.#staff(input.accessToken, ADMIN_SERVICE_REQUEST_READ_PERMISSION);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeAdminServiceRequestsCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a cursor from the buyer's own list, whose
      // order is the opposite of this one. Paging silently from the beginning would quietly repeat rows
      // somebody had already worked through.
      if (position === null) throw new AdminServiceRequestsCursorInvalidError();
    }

    let rows: readonly AdminServiceRequestRow[];
    try {
      rows = await this.store.serviceRequestsAdminOnlyQueue({
        userId: staff.id,
        isAal2: staff.isAal2,
        status: input.status,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The Admin Only service request queue could not be read.');
      throw new AdminServiceRequestsUnavailableError(error);
    }

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined && last.createdAt !== null
        ? encodeAdminServiceRequestsCursor({ createdAt: toDate(last.createdAt), id: last.id })
        : null;

    return { items: page.map((row) => this.#summary(row)), nextCursor };
  }

  /** One Admin Only request in full. Never with a payment field: they are not in this shape. */
  async detail(input: { accessToken: string; requestId: string }): Promise<AdminServiceRequestDetail> {
    const staff = await this.#staff(input.accessToken, ADMIN_SERVICE_REQUEST_READ_PERMISSION);

    let row: AdminServiceRequestDetailRow;
    try {
      row = await this.store.serviceRequestAdminOnlyDetail({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
      });
    } catch (error) {
      this.logger.error('An Admin Only service request could not be read.');
      throw new AdminServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new AdminServiceRequestNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('An Admin Only read returned an outcome this service does not understand.');
      throw new AdminServiceRequestsUnavailableError(new Error('unexpected outcome'));
    }
    if (row.brief === null) {
      this.logger.error('An Admin Only service request came back incomplete.');
      throw new AdminServiceRequestsUnavailableError(new Error('incomplete request'));
    }

    return { ...this.#summary(row), brief: row.brief };
  }

  /**
   * The two descriptive payment fields.
   *
   * Its own permission, checked here and again in the database. A caller holding only the request key gets the
   * ordinary not-found — the same answer as for a request that is not there — so asking does not reveal that a
   * brief exists whose payment information is being withheld.
   */
  async paymentInformation(input: {
    accessToken: string;
    requestId: string;
  }): Promise<ServiceRequestPaymentInformation> {
    const staff = await this.#staff(input.accessToken, SERVICE_REQUEST_PAYMENT_INFO_PERMISSION);

    let row: ServiceRequestPaymentInformationRow;
    try {
      row = await this.store.serviceRequestPaymentInformation({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
      });
    } catch (error) {
      this.logger.error('Service request payment information could not be read.');
      throw new AdminServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new AdminServiceRequestNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A payment information read returned an outcome this service does not understand.');
      throw new AdminServiceRequestsUnavailableError(new Error('unexpected outcome'));
    }

    // Field by field, and both nullable: the retention job clears them, and a purged request reads as two
    // nulls rather than as an absence.
    return {
      preferredPaymentMethod: row.preferredPaymentMethod ?? null,
      paymentNotes: row.paymentNotes ?? null,
    };
  }

  /**
   * The approved staff closure: `open → declined`.
   *
   * Requires the manage key, not the read key. It records a status and a closing time; it creates no quote, no
   * obligation, no payment deadline and no order, and it sends no notification. On an Admin Only request
   * `declined` means the platform closed it without fulfilment — a different fact from the same status on a
   * seller-routed request, where it means the seller declined to quote. The two are written by different
   * database functions whose predicates cannot reach each other's rows.
   */
  async decline(input: {
    accessToken: string;
    requestId: string;
  }): Promise<AdminServiceRequestDecisionResponse> {
    const staff = await this.#staff(input.accessToken, ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION);

    let row: AdminServiceRequestDecisionRow;
    try {
      row = await this.store.serviceRequestAdminDecline({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
      });
    } catch (error) {
      this.logger.error('An Admin Only service request could not be closed.');
      throw new AdminServiceRequestsUnavailableError(error);
    }

    if (row.outcome === 'declined') {
      if (row.status === null) {
        this.logger.error('An Admin Only closure came back without a status.');
        throw new AdminServiceRequestsUnavailableError(new Error('incomplete closure'));
      }
      return { status: row.status as ServiceRequestStatus };
    }
    if (row.outcome === 'not_found') throw new AdminServiceRequestNotFoundError();
    if (row.outcome === 'conflict') throw new AdminServiceRequestNotActionableError();
    this.logger.error('An Admin Only closure returned an outcome this service does not understand.');
    throw new AdminServiceRequestsUnavailableError(new Error('unexpected outcome'));
  }

  /* ------------------------------------------------------------------------------------------------ */

  /**
   * The caller's account and assurance level, once they are known to hold one named key.
   *
   * A caller who does not is a not-found rather than a 403, for the reason set out in the errors file. The key
   * is a parameter of this private method only, never of a public one: no route and no body can name it.
   */
  async #staff(accessToken: string, permission: string): Promise<{ id: string; isAal2: boolean }> {
    // The provider validates the token inside `forToken`; only then is a claim read from it. That order is
    // 7-F's and is not varied here.
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new AdminServiceRequestNotFoundError();
    // The level is read from the same validated token rather than assumed from the permission being present.
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  /** Projected field by field, so a later widening of the database function cannot carry anything outward. */
  #summary(row: AdminServiceRequestRow): AdminServiceRequestSummary {
    if (
      row.title === null ||
      row.currencyCode === null ||
      row.currencyMinorUnit === null ||
      row.hasPaymentNotes === null ||
      row.createdAt === null ||
      row.updatedAt === null
    ) {
      this.logger.error('An Admin Only service request row came back incomplete.');
      throw new AdminServiceRequestsUnavailableError(new Error('incomplete row'));
    }
    return {
      id: row.id,
      status: row.status as ServiceRequestStatus,
      title: row.title,
      budgetMinor: amountOrNull(row.budgetMinor),
      currencyCode: row.currencyCode,
      currencyMinorUnit: row.currencyMinorUnit,
      neededBy: dateOrNull(row.neededBy),
      buyerName: row.buyerName,
      hasPaymentNotes: row.hasPaymentNotes,
      closedAt: toIsoOrNull(row.closedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
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
