import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ListingModerationAction,
  ListingModerationRow,
  ListingStatus,
  ModerateListingRequest,
  ModerateListingResponse,
  ModerationActionKind,
  ModerationActionRow,
  ModerationListingDetail,
  ModerationListingRow,
  ModerationReportDetail,
  ModerationReportRow,
  ReportPriority,
  ReportStatus,
  ReportSubjectTypeAll,
  ResolveReportRequest,
  ResolveReportResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  ListingIsOwnError,
  ListingModerationNoChangeError,
  ListingModerationNotApplicableError,
  ModerationCursorInvalidError,
  ModerationInvalidError,
  ModerationNotFoundError,
  ModerationUnavailableError,
  ReportAlreadyFinalError,
  ReportIsOwnError,
} from './moderation.errors.js';
import {
  decodeModerationListingsCursor,
  decodeModerationReportsCursor,
  encodeModerationListingsCursor,
  encodeModerationReportsCursor,
} from './moderation.cursor.js';

/**
 * Listing moderation and report management (Phase 7-N).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      Every role that holds a moderation key requires MFA, so staff at `aal1` hold nothing at all — asking
 *      whether the effective set contains a key is therefore the AAL2 check and the permission check at
 *      once, and there is no separate assurance test here that could be forgotten on one route.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account
 *      and the assurance level as parameters and the key as a literal. No bug in this file can turn into
 *      somebody's report or somebody's listing.
 *
 * **Five keys, and each route requires exactly the one the database requires.** Reading reports needs
 * `moderation.report.read`; resolving one needs `moderation.report.manage`; either moderation trail needs
 * `moderation.action.read`, which is what 0027's own policy gates those tables on and is *not* the report
 * key; reading a listing needs `catalog.listing.read`; moderating one needs `catalog.listing.moderate`,
 * which is what 0011's own write policy requires. **No role name is checked anywhere in this file.**
 *
 * **Every rule this surface appears to apply is applied in the database.** Which statuses a report may move
 * to, that a decision carries a reason, that a duplicate names its original, that nobody rules on their own
 * report or moderates their own listing, which status each listing action lands on, that an action must move
 * the status, and that a listing cannot go live without a price — all of it is decided inside migration
 * 0077's wrappers, which call 0027's own writers with the rows locked. This service passes the caller's
 * account, translates the outcome into the approved error, and **checks nothing a second time**.
 *
 * **A refusal and an absence are the same answer.** A report or a listing that does not exist, and a caller
 * without the key, all arrive as `not_found` and all become one {@link ModerationNotFoundError}. The four
 * conflicts are the cases that disclose nothing: the caller's own report, the caller's own listing, a
 * decision already made, and an action the listing cannot take.
 *
 * **No event, no notification and no audit entry is written here.** `moderate_listing` writes both
 * moderation trails and enqueues `moderation.action_recorded`; `reports` and `listings` carry their own audit
 * triggers; 0011's status trigger records the listing's move and publishes its own revalidation event. Every
 * one of those happens inside the delegation, once. Nothing in this repository consumes a moderation event
 * into a notification or a template, so none is emitted and no vocabulary is invented — 7-D is untouched.
 *
 * **Nothing here logs a value.** A report is an accusation and a moderation reason is a decision about
 * somebody's livelihood. The log lines below carry a sentence and no identifier, no reason and no note.
 */

export const MODERATION_REPORT_READ = 'moderation.report.read';
export const MODERATION_REPORT_MANAGE = 'moderation.report.manage';
export const MODERATION_ACTION_READ = 'moderation.action.read';
export const CATALOG_LISTING_READ = 'catalog.listing.read';
export const CATALOG_LISTING_MODERATE = 'catalog.listing.moderate';

/** One row of `app_private.moderation_report_queue`. */
export interface ModerationReportQueueRow {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectLabel: string | null;
  readonly reasonCode: string;
  readonly status: string;
  readonly priority: string;
  readonly isOwnReport: boolean;
  readonly actionCount: number;
  readonly createdAt: Date | string;
}

/** One row of `app_private.moderation_report_for_staff`. */
export interface ModerationReportDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly subjectType: string | null;
  readonly subjectSlug: string | null;
  readonly subjectLabel: string | null;
  readonly subjectStatus: string | null;
  readonly subjectIsResolvable: boolean | null;
  readonly reasonCode: string | null;
  readonly details: string | null;
  readonly status: string | null;
  readonly priority: string | null;
  readonly isOwnReport: boolean | null;
  readonly resolution: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date | string | null;
  readonly resolvedByMe: boolean | null;
  readonly duplicateOfReportId: string | null;
  readonly createdAt: Date | string | null;
  readonly updatedAt: Date | string | null;
}

/** One row of `app_private.moderation_actions_for_subject`. */
export interface ModerationActionTrailRow {
  readonly id: string;
  readonly action: string;
  readonly reason: string;
  readonly notes: string | null;
  readonly reportId: string | null;
  readonly expiresAt: Date | string | null;
  readonly reversesActionId: string | null;
  readonly isOwnAction: boolean;
  readonly createdAt: Date | string;
}

/** One row of `app_private.listing_moderation_history`. */
export interface ListingModerationTrailRow {
  readonly id: string;
  readonly action: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string;
  readonly reportId: string | null;
  readonly isOwnAction: boolean;
  readonly createdAt: Date | string;
}

/** One row of `app_private.moderation_listing_queue`. */
export interface ModerationListingQueueRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly listingTypeCode: string;
  readonly currencyCode: string;
  readonly priceMinor: string | number | bigint | null;
  readonly isOwnListing: boolean;
  readonly reportCount: number;
  readonly createdAt: Date | string;
}

/** One row of `app_private.moderation_listing_for_staff`. */
export interface ModerationListingDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly contentLanguage: string | null;
  readonly status: string | null;
  readonly listingTypeCode: string | null;
  readonly currencyCode: string | null;
  readonly priceMinor: string | number | bigint | null;
  readonly city: string | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly isOwnListing: boolean | null;
  readonly canModerate: boolean | null;
  readonly openReportCount: number | null;
  readonly createdAt: Date | string | null;
  readonly approvedAt: Date | string | null;
}

/** One row of either write wrapper. */
export interface ModerationWriteRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface ModerationStore {
  moderationReportQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ModerationReportQueueRow[]>;

  moderationReportForStaff(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
  }): Promise<ModerationReportDetailRow>;

  moderationActionsForSubject(input: {
    userId: string;
    isAal2: boolean;
    subjectType: string;
    subjectId: string;
    limit: number;
  }): Promise<readonly ModerationActionTrailRow[]>;

  moderationActionsForReport(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
    limit: number;
  }): Promise<readonly ModerationActionTrailRow[]>;

  listingModerationHistory(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
    limit: number;
  }): Promise<readonly ListingModerationTrailRow[]>;

  moderationListingQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ModerationListingQueueRow[]>;

  moderationListingForStaff(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
  }): Promise<ModerationListingDetailRow>;

  moderationReportResolve(input: {
    userId: string;
    isAal2: boolean;
    reportId: string;
    status: string;
    resolutionNote: string | null;
    duplicateOfReportId: string | null;
  }): Promise<ModerationWriteRow>;

  moderationListingModerate(input: {
    userId: string;
    isAal2: boolean;
    listingId: string;
    action: string;
    reason: string;
    reportId: string | null;
  }): Promise<ModerationWriteRow>;
}

export const MODERATION_STORE = Symbol('MODERATION_STORE');

export interface ModerationReportQueuePage {
  readonly items: readonly ModerationReportRow[];
  readonly nextCursor: string | null;
}

export interface ModerationListingQueuePage {
  readonly items: readonly ModerationListingRow[];
  readonly nextCursor: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** A `bigint` minor amount as the decimal string the contract carries. */
function minorAmount(value: string | number | bigint | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(MODERATION_STORE) private readonly store: ModerationStore,
    private readonly console: StaffConsoleService,
  ) {}

  /* ---------------------------------------------------------------------------------------------- */
  /* Reports                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * One page of the report queue, oldest first.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when the page is the
   * last one rather than one request later.
   */
  async reportQueue(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<ModerationReportQueuePage> {
    const staff = await this.#staff(input.accessToken, MODERATION_REPORT_READ);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeModerationReportsCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from the listing queue,
      // whose rows are a different table entirely.
      if (position === null) throw new ModerationCursorInvalidError();
    }

    let rows: readonly ModerationReportQueueRow[];
    try {
      rows = await this.store.moderationReportQueue({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as a parameter. An unknown value matches nothing in the database rather than being
        // refused here, which is the reader's own documented behaviour.
        status: input.status,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The report queue could not be read.');
      throw new ModerationUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#reportRow(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeModerationReportsCursor({ createdAt: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One report. A missing one and a caller without the key are the same answer. */
  async report(input: { accessToken: string; reportId: string }): Promise<ModerationReportDetail> {
    const staff = await this.#staff(input.accessToken, MODERATION_REPORT_READ);

    let row: ModerationReportDetailRow;
    try {
      row = await this.store.moderationReportForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        reportId: input.reportId,
      });
    } catch (error) {
      this.logger.error('A report could not be read.');
      throw new ModerationUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return this.#reportDetail(row);
  }

  /** The moderation actions citing one report. Gated on the action key, which is not the report key. */
  async reportActions(input: {
    accessToken: string;
    reportId: string;
    limit: number;
  }): Promise<readonly ModerationActionRow[]> {
    const staff = await this.#staff(input.accessToken, MODERATION_ACTION_READ);

    let rows: readonly ModerationActionTrailRow[];
    try {
      rows = await this.store.moderationActionsForReport({
        userId: staff.id,
        isAal2: staff.isAal2,
        reportId: input.reportId,
        limit: input.limit,
      });
    } catch (error) {
      this.logger.error('A report’s moderation actions could not be read.');
      throw new ModerationUnavailableError(error);
    }
    return rows.map((row) => this.#actionRow(row));
  }

  /**
   * Records a decision on one report.
   *
   * Every rule is 0027's, applied inside 0077's wrapper with the row locked: the four statuses, the required
   * note, the original a duplicate must name, the caller's own report, and a report already decided.
   */
  async resolveReport(input: {
    accessToken: string;
    reportId: string;
    request: ResolveReportRequest;
  }): Promise<ResolveReportResponse> {
    const staff = await this.#staff(input.accessToken, MODERATION_REPORT_MANAGE);

    let row: ModerationWriteRow;
    try {
      row = await this.store.moderationReportResolve({
        userId: staff.id,
        isAal2: staff.isAal2,
        reportId: input.reportId,
        status: input.request.status,
        resolutionNote: input.request.resolutionNote ?? null,
        duplicateOfReportId: input.request.duplicateOfReportId ?? null,
      });
    } catch (error) {
      this.logger.error('A report decision could not be recorded.');
      throw new ModerationUnavailableError(error);
    }

    if (row.outcome !== 'resolved' || row.status === null) this.#refusal(row.outcome);
    return { outcome: 'resolved', status: row.status as ReportStatus };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Listings                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  /** One page of the listings awaiting review, oldest first. */
  async listingQueue(input: {
    accessToken: string;
    limit: number;
    cursor: string | null;
  }): Promise<ModerationListingQueuePage> {
    const staff = await this.#staff(input.accessToken, CATALOG_LISTING_READ);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeModerationListingsCursor(input.cursor);
      if (position === null) throw new ModerationCursorInvalidError();
    }

    let rows: readonly ModerationListingQueueRow[];
    try {
      rows = await this.store.moderationListingQueue({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The listing moderation queue could not be read.');
      throw new ModerationUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#listingRow(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeModerationListingsCursor({ createdAt: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One listing, with what a decision needs. */
  async listing(input: { accessToken: string; listingId: string }): Promise<ModerationListingDetail> {
    const staff = await this.#staff(input.accessToken, CATALOG_LISTING_READ);

    let row: ModerationListingDetailRow;
    try {
      row = await this.store.moderationListingForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        listingId: input.listingId,
      });
    } catch (error) {
      this.logger.error('A listing could not be read for moderation.');
      throw new ModerationUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return this.#listingDetail(row);
  }

  /** One listing's moderation trail. Gated on the action key. */
  async listingHistory(input: {
    accessToken: string;
    listingId: string;
    limit: number;
  }): Promise<readonly ListingModerationRow[]> {
    const staff = await this.#staff(input.accessToken, MODERATION_ACTION_READ);

    let rows: readonly ListingModerationTrailRow[];
    try {
      rows = await this.store.listingModerationHistory({
        userId: staff.id,
        isAal2: staff.isAal2,
        listingId: input.listingId,
        limit: input.limit,
      });
    } catch (error) {
      this.logger.error('A listing’s moderation trail could not be read.');
      throw new ModerationUnavailableError(error);
    }
    return rows.map((row) => this.#listingTrailRow(row));
  }

  /**
   * Moderates one listing.
   *
   * The writer moves the status, writes both trails and enqueues its own event in one transaction with the
   * row locked. Nothing is written a second time here, and the four refusals are its own and the schema's.
   */
  async moderateListing(input: {
    accessToken: string;
    listingId: string;
    request: ModerateListingRequest;
  }): Promise<ModerateListingResponse> {
    const staff = await this.#staff(input.accessToken, CATALOG_LISTING_MODERATE);

    let row: ModerationWriteRow;
    try {
      row = await this.store.moderationListingModerate({
        userId: staff.id,
        isAal2: staff.isAal2,
        listingId: input.listingId,
        action: input.request.action,
        reason: input.request.reason,
        reportId: input.request.reportId ?? null,
      });
    } catch (error) {
      this.logger.error('A listing moderation decision could not be recorded.');
      throw new ModerationUnavailableError(error);
    }

    if (row.outcome !== 'moderated' || row.status === null) this.#refusal(row.outcome);
    return { outcome: 'moderated', status: row.status as ListingStatus };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /**
   * The caller's account and assurance level, in the one order.
   *
   * The provider validates the token inside `forToken`; only then is a claim read from it. Every role that
   * holds one of these keys requires MFA, so a caller at `aal1` has an empty effective set and this check is
   * the assurance test as well as the permission test.
   */
  async #staff(accessToken: string, permission: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new ModerationNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  /** The one place an outcome that is not a success becomes an error. */
  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new ModerationNotFoundError();
    if (outcome === 'invalid') throw new ModerationInvalidError();
    if (outcome === 'own_report') throw new ReportIsOwnError();
    if (outcome === 'already_final') throw new ReportAlreadyFinalError();
    if (outcome === 'own_listing') throw new ListingIsOwnError();
    if (outcome === 'no_change') throw new ListingModerationNoChangeError();
    if (outcome === 'not_applicable') throw new ListingModerationNotApplicableError();
    this.logger.error('A moderation operation returned an outcome this service does not understand.');
    throw new ModerationUnavailableError(new Error('unexpected outcome'));
  }

  #reportRow(row: ModerationReportQueueRow): ModerationReportRow {
    return {
      id: row.id,
      subjectType: row.subjectType as ReportSubjectTypeAll,
      subjectLabel: row.subjectLabel,
      reasonCode: row.reasonCode as ModerationReportRow['reasonCode'],
      status: row.status as ReportStatus,
      priority: row.priority as ReportPriority,
      isOwnReport: row.isOwnReport,
      actionCount: row.actionCount,
      createdAt: toIso(row.createdAt),
    };
  }

  #reportDetail(row: ModerationReportDetailRow): ModerationReportDetail {
    if (
      row.id === null ||
      row.subjectType === null ||
      row.reasonCode === null ||
      row.status === null ||
      row.priority === null ||
      row.isOwnReport === null ||
      row.subjectIsResolvable === null ||
      row.resolvedByMe === null ||
      row.createdAt === null ||
      row.updatedAt === null
    ) {
      this.logger.error('A report came back incomplete.');
      throw new ModerationUnavailableError(new Error('incomplete report'));
    }
    return {
      id: row.id,
      subjectType: row.subjectType as ReportSubjectTypeAll,
      subjectSlug: row.subjectSlug,
      subjectLabel: row.subjectLabel,
      subjectStatus: row.subjectStatus as ListingStatus | null,
      subjectIsResolvable: row.subjectIsResolvable,
      reasonCode: row.reasonCode as ModerationReportDetail['reasonCode'],
      details: row.details,
      status: row.status as ReportStatus,
      priority: row.priority as ReportPriority,
      isOwnReport: row.isOwnReport,
      resolution: row.resolution as ModerationReportDetail['resolution'],
      resolutionNote: row.resolutionNote,
      resolvedAt: toIsoOrNull(row.resolvedAt),
      resolvedByMe: row.resolvedByMe,
      duplicateOfReportId: row.duplicateOfReportId,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  #actionRow(row: ModerationActionTrailRow): ModerationActionRow {
    return {
      id: row.id,
      action: row.action as ModerationActionKind,
      reason: row.reason,
      notes: row.notes,
      reportId: row.reportId,
      expiresAt: toIsoOrNull(row.expiresAt),
      reversesActionId: row.reversesActionId,
      isOwnAction: row.isOwnAction,
      createdAt: toIso(row.createdAt),
    };
  }

  #listingTrailRow(row: ListingModerationTrailRow): ListingModerationRow {
    return {
      id: row.id,
      action: row.action as ListingModerationAction,
      fromStatus: row.fromStatus as ListingStatus,
      toStatus: row.toStatus as ListingStatus,
      reason: row.reason,
      reportId: row.reportId,
      isOwnAction: row.isOwnAction,
      createdAt: toIso(row.createdAt),
    };
  }

  #listingRow(row: ModerationListingQueueRow): ModerationListingRow {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status as ListingStatus,
      listingTypeCode: row.listingTypeCode,
      currencyCode: row.currencyCode,
      priceMinor: minorAmount(row.priceMinor),
      isOwnListing: row.isOwnListing,
      reportCount: row.reportCount,
      createdAt: toIso(row.createdAt),
    };
  }

  #listingDetail(row: ModerationListingDetailRow): ModerationListingDetail {
    if (
      row.id === null ||
      row.slug === null ||
      row.title === null ||
      row.description === null ||
      row.contentLanguage === null ||
      row.status === null ||
      row.listingTypeCode === null ||
      row.currencyCode === null ||
      row.isOwnListing === null ||
      row.canModerate === null ||
      row.openReportCount === null ||
      row.createdAt === null
    ) {
      this.logger.error('A listing came back incomplete.');
      throw new ModerationUnavailableError(new Error('incomplete listing'));
    }
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      contentLanguage: row.contentLanguage,
      status: row.status as ListingStatus,
      listingTypeCode: row.listingTypeCode,
      currencyCode: row.currencyCode,
      priceMinor: minorAmount(row.priceMinor),
      city: row.city,
      sellerSlug: row.sellerSlug,
      sellerDisplayName: row.sellerDisplayName,
      isOwnListing: row.isOwnListing,
      canModerate: row.canModerate,
      openReportCount: row.openReportCount,
      createdAt: toIso(row.createdAt),
      approvedAt: toIsoOrNull(row.approvedAt),
    };
  }
}
