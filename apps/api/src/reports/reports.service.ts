import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  FileReportRequest,
  ReportStatus,
  ReportSubjectType,
  ReporterReport,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import { ReportsThrottleService } from './reports-throttle.service.js';
import {
  ReportSubjectIsTheReporterError,
  ReportSubjectNotFoundError,
  ReportSubjectNotReportableError,
  ReportsCursorInvalidError,
} from './reports.errors.js';
import { decodeReportsCursor, encodeReportsCursor } from './reports-cursor.js';

/**
 * Reports — the reporter side (Phase 7-M).
 *
 * **Every rule this surface appears to apply is applied in the database.** Whether a slug names anything,
 * whether the public may see what it names, whether the subject type is one this path files, whether the
 * reason is one the table allows, whether the reporter is reporting themselves, and whether this is a new
 * report or the one they already have open — all of it is decided inside migration 0076's SECURITY DEFINER
 * function, which delegates the report itself to 0027's own `file_report`. This service passes the caller's
 * own account, translates the outcome into the approved error, and **checks nothing a second time**.
 *
 * **No method takes a reporter, and no request can name one.** The account arrives from the caller's own
 * validated token through {@link CurrentUserService}; the contract has no field for an identity; and there
 * is no parameter anywhere in this file through which a caller could file as somebody else.
 *
 * **No method takes a subject id.** A report names its subject by the **slug the page is addressed by**, and
 * the database resolves it. That is not a filter over a dangerous parameter — it is the absence of the
 * parameter: 0050's public seller projection deliberately never publishes a seller's account id, so there is
 * no id for a browser to hold, to guess at or to substitute.
 *
 * **A refusal and an absence are the same answer.** A draft listing, a listing whose seller is not publicly
 * visible, a withdrawn storefront and a slug that names nothing all arrive as `not_found` and all become one
 * {@link ReportSubjectNotFoundError}. There is no branch here that could tell them apart.
 *
 * **Nothing about moderation is read or written.** This service creates no moderation action, assigns
 * nothing, resolves nothing and reads no moderation column — the reader it calls does not return one. A
 * report is a request for a look.
 *
 * **No notification and no email.** `file_report` already enqueues the `report.filed` outbox event that
 * 0027 defined, and nothing in this repository consumes it into a notification or a template. So nothing is
 * emitted here: not a second event, not a notification row, not a queued message. 7-D is untouched.
 *
 * **No audit entry is written here either.** `reports` carries 0027's own audit trigger, which records the
 * insert with `details` redacted, and `file_report` enqueues the event. Writing a third record of the same
 * fact at this layer would be duplication, and the two that exist are the repository's own.
 *
 * **Filing is rate limited; the read is not.** Every attempt counts against
 * {@link ReportsThrottleService}'s one bucket *before* the subject is resolved, so a refused attempt still
 * counts and the limit cannot be turned into an instrument for discovering which slugs exist. The subject is
 * always `hashIdentifier(userId)` of the account the provider vouched for.
 *
 * **Nothing here logs a value.** A report is an accusation in somebody's own words about somebody else. The
 * log lines below carry a sentence and no identifier, no slug, no reason and no details.
 */

/** One row of `app_private.report_file_for_reporter`. */
export interface ReportFilingRow {
  readonly outcome: string;
  readonly reportId: string | null;
}

/** One row of `app_private.reports_for_reporter`. */
export interface ReporterReportRow {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectSlug: string | null;
  readonly subjectLabel: string | null;
  readonly reasonCode: string;
  readonly details: string | null;
  readonly status: string;
  readonly createdAt: Date | string;
}

export interface ReportsStore {
  reportFileForReporter(input: {
    userId: string;
    subjectType: string;
    subjectSlug: string;
    reasonCode: string;
    details: string | null;
  }): Promise<ReportFilingRow>;

  reportsForReporter(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ReporterReportRow[]>;
}

export const REPORTS_STORE = Symbol('REPORTS_STORE');

export interface ReporterReportsPage {
  readonly items: readonly ReporterReport[];
  readonly nextCursor: string | null;
}

/** Raised when a read could not be performed at all. Becomes a 503. */
export class ReportsUnavailableError extends Error {
  readonly problem = { status: 503, code: 'SERVICE_UNAVAILABLE' } as const;

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ReportsUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(REPORTS_STORE) private readonly store: ReportsStore,
    private readonly throttle: ReportsThrottleService,
  ) {}

  /**
   * Files a report about a listing or a seller the caller can actually see.
   *
   * The throttle comes first, before the subject is resolved, for the reason the throttle's own comment
   * gives. Then one call, whose outcome is the whole of the decision.
   */
  async file(userId: string, request: FileReportRequest): Promise<{ reportId: string }> {
    await this.throttle.assertCanFileReport(hashIdentifier(userId));

    let row: ReportFilingRow;
    try {
      row = await this.store.reportFileForReporter({
        userId,
        subjectType: request.subjectType,
        subjectSlug: request.subjectSlug,
        reasonCode: request.reasonCode,
        // The contract has the field optional and the column nullable; an absent box is an absent value
        // rather than an empty string, which is what `reports_details_length` measures.
        details: request.details ?? null,
      });
    } catch (error) {
      this.logger.error('A report could not be filed.');
      throw new ReportsUnavailableError(error);
    }

    if (row.outcome === 'invalid') throw new ReportSubjectNotReportableError();
    if (row.outcome === 'own_subject') throw new ReportSubjectIsTheReporterError();
    if (row.outcome !== 'filed' || row.reportId === null) throw new ReportSubjectNotFoundError();
    return { reportId: row.reportId };
  }

  /**
   * One page of the caller's own reports.
   *
   * The page is read one row longer than asked for. If that extra row exists there is more to come, and the
   * cursor is built from the last row the caller actually receives — so `nextCursor` is null exactly when
   * the page is the last one, rather than one request later.
   */
  async own(input: { userId: string; limit: number; cursor: string | null }): Promise<ReporterReportsPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeReportsCursor(input.cursor);
      if (position === null) throw new ReportsCursorInvalidError();
    }

    let rows: readonly ReporterReportRow[];
    try {
      rows = await this.store.reportsForReporter({
        userId: input.userId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A report history could not be read.');
      throw new ReportsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#report(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeReportsCursor({ createdAt: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /**
   * One row, as the contract carries it.
   *
   * The row shape and the contract have the same eight fields, so this is a rename rather than a choice:
   * there is nothing here to leave out, because the reader never returned a moderation column in the first
   * place. The two vocabularies are narrowed to the contract's types without being re-checked — the
   * database's own constraints are what make them closed, and the response is validated at the boundary.
   */
  #report(row: ReporterReportRow): ReporterReport {
    return {
      id: row.id,
      subjectType: row.subjectType as ReportSubjectType,
      subjectSlug: row.subjectSlug,
      subjectLabel: row.subjectLabel,
      reasonCode: row.reasonCode as ReporterReport['reasonCode'],
      details: row.details,
      status: row.status as ReportStatus,
      createdAt: toIso(row.createdAt),
    };
  }
}
