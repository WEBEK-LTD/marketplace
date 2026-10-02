import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CounterOfferRequestSchema,
  CreateOfferRequestSchema,
  OFFERS_DEFAULT_LIMIT,
  OFFERS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type CounterOfferRequest,
  type CreateOfferRequest,
  type OfferDecisionResponse,
  type OfferMutationResponse,
  type OffersResponse,
  type SellerOffersResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OffersService } from '../offers/offers.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface OfferRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: OfferRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Offers: negotiation and acceptance (Phase 7-H).
 *
 * Every route here is authenticated and every one resolves the caller the same way: from their own access
 * token, through {@link CurrentUserService}. **No route accepts a user identifier, a role or a side.** The
 * only path parameter is an offer, which names a row and not a person, and the two lists are separate
 * operations rather than one with a `role` query — so there is no value a caller could send that would
 * show them the other side of a negotiation or let them act on it.
 *
 * **No route accepts a status, an acceptance time or a payment deadline.** The writes are named
 * transitions; `paymentDueAt` appears in no schema this controller accepts, and is derived in the database
 * from the acceptance time and the admin-configured window.
 *
 * The controller decides nothing about who may do what. Ownership, the state machine and the payment
 * window are all applied inside migration 0070's functions, with the row locked — restating any of them
 * here would be a second copy of a rule, and the copy without the lock is the one that would be wrong.
 *
 * Not here, deliberately: **no checkout, order, payment, refund, ledger, payout or shipping operation of
 * any kind.** An accepted offer records the payable obligation; Phase 8 is what consumes it.
 */
@Controller('v1/offers')
export class OffersController {
  constructor(
    private readonly offers: OffersService,
    private readonly users: CurrentUserService,
  ) {}

  @Get('made')
  async made(
    @Req() request: OfferRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<OffersResponse> {
    const userId = await this.caller(request);
    const page = await this.offers.made({
      userId,
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('received')
  async received(
    @Req() request: OfferRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerOffersResponse> {
    const userId = await this.caller(request);
    const page = await this.offers.received({
      userId,
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /**
   * Opens one offer.
   *
   * The body names a listing, an amount, a quantity and an optional note. There is no seller field, no
   * currency field and no expiry field, and the strict schema would refuse all three.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(CreateOfferRequestSchema)) body: CreateOfferRequest,
    @Req() request: OfferRequestContext,
  ): Promise<OfferMutationResponse> {
    const userId = await this.caller(request);
    return await this.offers.create({
      userId,
      listingId: body.listingId,
      amountMinor: body.amountMinor,
      quantity: body.quantity,
      message: body.message ?? null,
    });
  }

  /**
   * Replaces the caller's own live offer.
   *
   * The offer being replaced is the one in the route; there is no `parentOfferId` in the body, so a counter
   * cannot be pointed at a different negotiation than the one it addresses.
   */
  @Post(':offerId/counter')
  @HttpCode(201)
  async counter(
    @Param('offerId') offerId: string,
    @Body(new ZodValidationPipe(CounterOfferRequestSchema)) body: CounterOfferRequest,
    @Req() request: OfferRequestContext,
  ): Promise<OfferMutationResponse> {
    const userId = await this.caller(request);
    return await this.offers.counter({
      userId,
      offerId: this.identifier(offerId),
      amountMinor: body.amountMinor,
      quantity: body.quantity,
      message: body.message ?? null,
    });
  }

  /** The seller accepts. The only transition that records an obligation. */
  @Post(':offerId/accept')
  @HttpCode(200)
  async accept(
    @Param('offerId') offerId: string,
    @Req() request: OfferRequestContext,
  ): Promise<OfferDecisionResponse> {
    const userId = await this.caller(request);
    return await this.offers.accept({ userId, offerId: this.identifier(offerId) });
  }

  /** The seller declines. */
  @Post(':offerId/reject')
  @HttpCode(200)
  async reject(
    @Param('offerId') offerId: string,
    @Req() request: OfferRequestContext,
  ): Promise<OfferDecisionResponse> {
    const userId = await this.caller(request);
    return await this.offers.reject({ userId, offerId: this.identifier(offerId) });
  }

  /** The buyer takes their own offer back. */
  @Post(':offerId/withdraw')
  @HttpCode(200)
  async withdraw(
    @Param('offerId') offerId: string,
    @Req() request: OfferRequestContext,
  ): Promise<OfferDecisionResponse> {
    const userId = await this.caller(request);
    return await this.offers.withdraw({ userId, offerId: this.identifier(offerId) });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: OfferRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: OFFERS_DEFAULT_LIMIT,
      maximum: OFFERS_MAX_LIMIT,
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
  private identifier(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'offerId', message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
