import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CreateAdminOnlyServiceRequestSchema,
  CreateServiceRequestSchema,
  SERVICE_REQUESTS_DEFAULT_LIMIT,
  SERVICE_REQUESTS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type CreateAdminOnlyServiceRequest,
  type CreateServiceRequest,
  type ServiceRequestDetailResponse,
  type ServiceRequestMutationResponse,
  type ServiceRequestStatusResponse,
  type ServiceRequestsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ServiceRequestsService } from '../services/service-requests.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ServiceRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: ServiceRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Service requests and quotes — Option 1 (Phase 7-I).
 *
 * Every route here is authenticated and every one resolves the caller the same way: from their own access
 * token, through {@link CurrentUserService}. **No route accepts a user identifier, a role or a side.** The path
 * parameters are a request and a quote, both of which name rows, and the two lists are separate operations
 * rather than one with a `role` query — so there is no value a caller could send that would show them the
 * other side of an exchange or let them act on it.
 *
 * **No route accepts a status, a currency, an acceptance time or a payment deadline.** The writes are named
 * transitions; the currency of a quote is copied from the request in the database; and `paymentDueAt` appears
 * in no schema this controller accepts.
 *
 * **A quote is addressed through its own request.** The three quote transitions sit under
 * `/{requestId}/quotes/{quoteId}/…`, and the service refuses a quote that does not belong to that request —
 * so a quote identifier cannot be spent from the wrong page.
 *
 * The controller decides nothing about who may do what. Ownership, both state machines and the payment window
 * are applied inside migration 0071's functions with the rows locked; restating any of them here would be a
 * second copy of a rule, and the copy without the lock is the one that would be wrong.
 *
 * Not here, deliberately: **no checkout, order, delivery, payment, refund, ledger or payout operation**, and
 * **nothing that routes a request to staff** — Option 2 is 7-J's and has no surface in this file.
 */
@Controller('v1/service-requests')
export class ServiceRequestsController {
  constructor(
    private readonly requests: ServiceRequestsService,
    private readonly users: CurrentUserService,
  ) {}

  @Get('made')
  async made(
    @Req() request: ServiceRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ServiceRequestsResponse> {
    const userId = await this.caller(request);
    const page = await this.requests.made({
      userId,
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':requestId')
  async detail(
    @Param('requestId') requestId: string,
    @Req() request: ServiceRequestContext,
  ): Promise<ServiceRequestDetailResponse> {
    const userId = await this.caller(request);
    return {
      request: await this.requests.detail({
        userId,
        requestId: this.identifier(requestId, 'requestId'),
      }),
    };
  }

  /**
   * Sends one brief.
   *
   * The body names a listing, a title, a brief and optionally a budget and a date. There is no seller field
   * and no currency field, and the strict schema would refuse both.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(CreateServiceRequestSchema)) body: CreateServiceRequest,
    @Req() request: ServiceRequestContext,
  ): Promise<ServiceRequestMutationResponse> {
    const userId = await this.caller(request);
    return await this.requests.create({
      userId,
      listingId: body.listingId,
      title: body.title,
      brief: body.brief,
      budgetMinor: body.budgetMinor ?? null,
      neededBy: body.neededBy ?? null,
    });
  }

  /**
   * Sends one Admin Only brief (Phase 7-J).
   *
   * A separate operation from the one above, not a mode on it: **the caller does not choose the flow.** The
   * body names a title, a brief, how they would prefer to pay, and optionally a budget and a date. There is no
   * listing, no seller, no currency and no routing field, and the strict schema would refuse every one of them.
   *
   * The name of the route describes the row it produces, not a privilege the caller holds: any authenticated
   * buyer may send one, and the server is what writes the routing mode.
   */
  @Post('admin-only')
  @HttpCode(201)
  async createAdminOnly(
    @Body(new ZodValidationPipe(CreateAdminOnlyServiceRequestSchema)) body: CreateAdminOnlyServiceRequest,
    @Req() request: ServiceRequestContext,
  ): Promise<ServiceRequestMutationResponse> {
    const userId = await this.caller(request);
    return await this.requests.createAdminOnly({
      userId,
      title: body.title,
      brief: body.brief,
      preferredPaymentMethod: body.preferredPaymentMethod,
      paymentNotes: body.paymentNotes ?? null,
      budgetMinor: body.budgetMinor ?? null,
      neededBy: body.neededBy ?? null,
    });
  }

  @Post(':requestId/cancel')
  @HttpCode(200)
  async cancel(
    @Param('requestId') requestId: string,
    @Req() request: ServiceRequestContext,
  ): Promise<ServiceRequestStatusResponse> {
    const userId = await this.caller(request);
    return await this.requests.cancel({
      userId,
      requestId: this.identifier(requestId, 'requestId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: ServiceRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
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
   * A path parameter that names a row.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database error,
   * and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
