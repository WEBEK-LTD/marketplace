import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  SERVICE_REQUESTS_DEFAULT_LIMIT,
  SERVICE_REQUESTS_MAX_LIMIT,
  SERVICE_REQUEST_STATUSES,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type AdminServiceRequestDecisionResponse,
  type AdminServiceRequestDetailResponse,
  type AdminServiceRequestsResponse,
  type ServiceRequestPaymentInformationResponse,
} from '@repo/contracts';
import { AdminServiceRequestsService } from '../admin/service-requests-admin.service.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { RequestValidationException } from '../common/request-validation.exception.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface AdminRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: AdminRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = new Set<string>(SERVICE_REQUEST_STATUSES);

/**
 * The Admin Only service request surface — Option 2 (Phase 7-J).
 *
 * **Nothing about the caller is in any request.** No account, no role, no permission and no assurance level in
 * a parameter, a header this controller reads or a body it accepts — there is no body on any route here. The
 * staff member is resolved from their own access token inside the service, on every route, and the only
 * identifier below names a row.
 *
 * **No status is in any request either**, except as a filter on the queue, whose values are the schema's own
 * six. The one write is a named transition, not a status assignment: a caller cannot ask for `accepted`,
 * `quoted` or `expired` because there is no field for it.
 *
 * **The payment fields are a separate operation, behind a separate permission.** Not a flag on the detail and
 * not a field the detail hides: a caller holding only `service_requests.request.read` receives a document in
 * which they do not exist, and this controller has no route that could return them alongside the request.
 *
 * The controller decides nothing about who may do what. Authorization is the permission key, applied in the
 * service and again inside every `app_private` function — restating it here would be a second copy of a rule.
 * A caller who may not read receives the ordinary not-found, identical to the answer for a request that is not
 * there and for a seller-routed one asked for on this surface.
 *
 * Not here, deliberately: **no quote, no checkout, no order, no payment, no delivery and no seller-side
 * anything.** Option 2 produces none of them, and this file has no route that could.
 */
@Controller('v1/admin/service-requests')
export class AdminServiceRequestsController {
  constructor(private readonly requests: AdminServiceRequestsService) {}

  @Get()
  async queue(
    @Req() request: AdminRequestContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<AdminServiceRequestsResponse> {
    const page = await this.requests.queue({
      accessToken: this.token(request),
      status: this.status(status),
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':requestId')
  async detail(
    @Param('requestId') requestId: string,
    @Req() request: AdminRequestContext,
  ): Promise<AdminServiceRequestDetailResponse> {
    return {
      request: await this.requests.detail({
        accessToken: this.token(request),
        requestId: this.identifier(requestId),
      }),
    };
  }

  /** The two descriptive fields, behind `service_requests.payment_info.read` and nothing less. */
  @Get(':requestId/payment-information')
  async paymentInformation(
    @Param('requestId') requestId: string,
    @Req() request: AdminRequestContext,
  ): Promise<ServiceRequestPaymentInformationResponse> {
    return {
      paymentInformation: await this.requests.paymentInformation({
        accessToken: this.token(request),
        requestId: this.identifier(requestId),
      }),
    };
  }

  /** The approved staff closure. Takes no body: there is nothing to say and no reason to record. */
  @Post(':requestId/decline')
  @HttpCode(200)
  async decline(
    @Param('requestId') requestId: string,
    @Req() request: AdminRequestContext,
  ): Promise<AdminServiceRequestDecisionResponse> {
    return await this.requests.decline({
      accessToken: this.token(request),
      requestId: this.identifier(requestId),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private token(request: AdminRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: SERVICE_REQUESTS_DEFAULT_LIMIT,
      maximum: SERVICE_REQUESTS_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    return parsed.limit;
  }

  /**
   * The queue filter.
   *
   * One of 0015's own six statuses, or nothing. Checked against the shared vocabulary rather than passed
   * through, so no value a caller invents reaches a parameter binding.
   */
  private status(value: string | undefined): string | null {
    if (value === undefined || value === '') return null;
    if (!STATUSES.has(value)) {
      throw new RequestValidationException([{ path: 'status', message: 'The status is invalid.' }]);
    }
    return value;
  }

  /** A path parameter that names a row. Checked here so nothing but an identifier reaches a binding. */
  private identifier(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'requestId', message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
