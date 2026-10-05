import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  FileReportRequestSchema,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type FileReportRequest,
  type FileReportResponse,
  type ReporterReportsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ReportsService } from '../reports/reports.service.js';
import { CurrentUserService } from '../users/current-user.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ReportsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: ReportsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Reports — the reporter side (Phase 7-M).
 *
 * Two operations, and deliberately no third: a report can be filed and the caller's own can be read. There
 * is nothing here that updates one, withdraws one, escalates one or asks after somebody else's, because a
 * report is a request for a look and the looking is 7-N's.
 *
 * **Login is required, and that is 0027's rule rather than a choice made here.**
 * `reports.reporter_user_id` is `not null` with a foreign key to `auth.users`, so a report without a
 * reporter is not a row this schema can hold. No guest path exists in the repository to preserve.
 *
 * **The caller is the reporter, and the body cannot say otherwise.** The account comes from the session
 * token on the request, validated by {@link CurrentUserService}; the request schema is `.strict()` and has
 * no identity field at all. There is no parameter in this file through which somebody could report as
 * somebody else.
 *
 * **A subject is addressed by its public slug.** No operation here takes a subject id, a listing id or a
 * seller account, so the familiar attack — spend an id from one page against another — has no field to
 * arrive in. 0076 resolves the slug through the same readers that decide whether the page renders at all.
 *
 * **201, not 200.** A report is a row this request brought into being, or the one the caller already had
 * open on the same subject — which 0027's C10 early return makes the same answer with the same id. 5-H's
 * messaging equivalent answers 200 for that reason; this surface answers 201 because the reporter is being
 * handed the identifier of their own new report and a page navigates on it. Both are success and both say
 * `filed`; neither tells the caller whether it was the first.
 *
 * The controller decides nothing about what may be reported. The subject's visibility, the vocabularies and
 * the self-report rule are all applied inside migration 0076's function, which calls 0027's own writer;
 * restating any of them here would be a second copy of a rule.
 */
@Controller('v1/reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly users: CurrentUserService,
  ) {}

  /**
   * Files one report.
   *
   * The body names a subject type, a public slug, one of the eleven existing reason codes and, optionally,
   * what the reporter wants to say. There is no status field, no priority field, no assignee field and no
   * reporter field, and the strict schema would refuse every one of them.
   */
  @Post()
  @HttpCode(201)
  async file(
    @Req() request: ReportsRequestContext,
    @Body(new ZodValidationPipe(FileReportRequestSchema)) body: FileReportRequest,
  ): Promise<FileReportResponse> {
    const userId = await this.caller(request);
    const { reportId } = await this.reports.file(userId, body);
    return { outcome: 'filed', reportId };
  }

  /** One page of the caller's own reports, newest first. */
  @Get()
  async own(
    @Req() request: ReportsRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ReporterReportsResponse> {
    const userId = await this.caller(request);
    const page = await this.reports.own({
      userId,
      limit: this.limit(limit, REPORTS_DEFAULT_LIMIT, REPORTS_MAX_LIMIT),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: ReportsRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }

  private limit(value: string | undefined, fallback: number, maximum: number): number {
    const parsed = parseMessagingLimit(value, { fallback, maximum });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }
}
