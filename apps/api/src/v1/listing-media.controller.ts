import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ListingMediaAttachRequestSchema,
  ListingMediaUploadRequestSchema,
  ListingSlugSchema,
  SESSION_TOKEN_HEADER,
  type ListingMediaAttachRequest,
  type ListingMediaAttachResponse,
  type ListingMediaListResponse,
  type ListingMediaUploadRequest,
  type ListingMediaUploadResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import {
  ListingMediaInvalidError,
  ListingMediaService,
  type ListingMediaCaller,
} from '../catalog/listing-media.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ListingMediaRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: ListingMediaRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * A listing's photographs (increment 0116, migration 0114).
 *
 * **One controller for both surfaces, because the database answers for both.** A seller manages their own
 * listing's pictures; staff holding `catalog.listing.moderate` at AAL2 manage anyone's. Those are not two
 * authorization models, they are two branches of `app_private.listing_media_can_manage` — so there is one set
 * of routes, and which of the two a caller is is a question nothing here asks. No route takes an actor, a
 * role, a permission key or an assurance level: the account comes from the caller's own access token through
 * `CurrentUserService.forToken`, and the assurance level from `isAal2` on that same now-validated token, in
 * that order.
 *
 * **Addressed by slug, like every other listing surface.** 0048's seller contract carries "no identifier of
 * any kind" on purpose, and this does not break that: the slug is resolved to an identifier by a database
 * function gated on the same predicate, so a slug the caller may not manage is a 404 before any body is read.
 *
 * **These paths cannot shadow the public listing detail.** `GET /v1/listings/:slug` is 4-B's public read and
 * stays exactly what it was; everything here is a longer path under `:slug/media`, which Fastify's router
 * matches separately. Nothing on this controller is reachable without a session.
 *
 * 201 for the authorization, because it creates something that did not exist — four signed, time-limited
 * permissions. 200 for everything else: confirming, reordering and withdrawing all change rows that are
 * already there, and each answers with the listing's photographs as they now stand, so a screen never has to
 * guess what its own write did.
 */
@Controller('v1/listings')
export class ListingMediaController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly media: ListingMediaService,
  ) {}

  /** `GET /v1/listings/:slug/media` — the photographs, as whoever may manage them sees them. */
  @Get(':slug/media')
  async list(
    @Req() request: ListingMediaRequestContext,
    @Param('slug') slug: string,
  ): Promise<ListingMediaListResponse> {
    const caller = await this.#caller(request);
    const listingId = await this.media.resolve(caller, this.#slug(slug));
    return { items: [...(await this.media.list(caller, listingId))] };
  }

  /** `POST /v1/listings/:slug/media/uploads` — authorize the four objects of one photograph. */
  @Post(':slug/media/uploads')
  @HttpCode(201)
  async authorize(
    @Req() request: ListingMediaRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(ListingMediaUploadRequestSchema)) body: ListingMediaUploadRequest,
  ): Promise<ListingMediaUploadResponse> {
    const caller = await this.#caller(request);
    const listingId = await this.media.resolve(caller, this.#slug(slug));
    const targets = await this.media.authorizeUpload(caller, listingId, body);
    // The contract requires four. Four were asked for and four came back, or an outcome ended it earlier.
    return { targets: [targets[0]!, targets[1]!, targets[2]!, targets[3]!] };
  }

  /** `POST /v1/listings/:slug/media` — confirm the four uploads as one photograph. */
  @Post(':slug/media')
  @HttpCode(200)
  async confirm(
    @Req() request: ListingMediaRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(ListingMediaAttachRequestSchema)) body: ListingMediaAttachRequest,
  ): Promise<ListingMediaAttachResponse> {
    const caller = await this.#caller(request);
    const listingId = await this.media.resolve(caller, this.#slug(slug));
    const result = await this.media.confirmUpload(caller, listingId, body);
    return { attachedId: result.attachedId, items: [...result.items] };
  }

  /** `PUT /v1/listings/:slug/media/:mediaId/primary` — make this one the photograph the card shows. */
  @Put(':slug/media/:mediaId/primary')
  @HttpCode(200)
  async setPrimary(
    @Req() request: ListingMediaRequestContext,
    @Param('slug') slug: string,
    @Param('mediaId') mediaId: string,
  ): Promise<ListingMediaListResponse> {
    const caller = await this.#caller(request);
    const listingId = await this.media.resolve(caller, this.#slug(slug));
    return { items: [...(await this.media.setPrimary(caller, listingId, this.#uuid(mediaId)))] };
  }

  /**
   * `DELETE /v1/listings/:slug/media/:mediaId` — withdraw one photograph.
   *
   * `DELETE` and not a status route, because from a seller's side this is removal: the row survives as
   * `withdrawn` and the object stays in the bucket, which is 0011's own model and is honest about the fact
   * that a public object cannot be unpublished by deleting a row. That distinction belongs in the migration's
   * comment, not in the verb a console uses.
   */
  @Delete(':slug/media/:mediaId')
  @HttpCode(200)
  async withdraw(
    @Req() request: ListingMediaRequestContext,
    @Param('slug') slug: string,
    @Param('mediaId') mediaId: string,
  ): Promise<ListingMediaListResponse> {
    const caller = await this.#caller(request);
    const listingId = await this.media.resolve(caller, this.#slug(slug));
    return { items: [...(await this.media.withdraw(caller, listingId, this.#uuid(mediaId)))] };
  }

  /**
   * The caller, from their own token, and their assurance level from the same one.
   *
   * `forToken` first: the level is read off a token only after the provider has said the token is valid, so a
   * forged `aal` claim in an unvalidated string never reaches a decision.
   */
  async #caller(request: ListingMediaRequestContext): Promise<ListingMediaCaller> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return { userId: user.id, isAal2: isAal2(accessToken) };
  }

  /** A slug shaped like a slug, refused here rather than carried into a query. */
  #slug(value: string): string {
    const parsed = ListingSlugSchema.safeParse(value);
    if (!parsed.success) throw new ListingMediaInvalidError();
    return parsed.data;
  }

  /** A photograph identifier shaped like one. A malformed uuid is a bad request, not a failed query. */
  #uuid(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
      throw new ListingMediaInvalidError();
    }
    return value;
  }
}
