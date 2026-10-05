import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SaveSellerListingAttributesRequestSchema,
  SaveSellerListingTagsRequestSchema,
  publicLocaleOf,
  type SaveSellerListingAttributesRequest,
  type SaveSellerListingTagsRequest,
  type SellerListingAttributesResponse,
  type SellerListingAttributesWriteResponse,
  type SellerListingTagsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  SellerVocabularyService,
  type SellerVocabularySurface,
} from '../sellers/seller-vocabulary.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerVocabularyRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerVocabularyRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The attributes and tags of the caller's own listings and services (Phase 8-C).
 *
 * Eight routes under `/v1/sellers/me/listings/:slug` and `/v1/sellers/me/services/:slug` — the namespace the
 * caller already uses for their own storefront, which is why not one of them takes a seller, an owner or an
 * account. The caller is resolved from their own access token before any body, query string or path segment is
 * used for anything.
 *
 * **The surface is the route's, not the request's.** Each route passes its own listing type to the database, so a
 * product reached through `/services/` is reported absent exactly as a slug that names nothing. A request has no
 * field that could say otherwise.
 *
 * **Reading and writing share an address, and the write is a POST.** Nothing under `/v1/sellers` replaces a
 * resource wholesale with a PUT, which is a rule this surface keeps even though a save does replace the whole set
 * of answers. There is no DELETE: clearing an answer is leaving it out of the save, and clearing every tag is an
 * empty array.
 *
 * **Why its own controller.** 6-F's listings and 6-G's services are approved and complete; attributes and tags are
 * a third thing managed through the same two addresses, and keeping them apart leaves those frozen routes
 * untouched. Nest mounts all three on `v1/sellers` without any shadowing another.
 *
 * **Nothing here submits anything.** `seller_listing_submit` is neither called nor imported, which is what makes
 * `is_required` advisory in this increment rather than a rule with an exception: a seller is told which attributes
 * are required, and the submission path is exactly the one 6-F approved.
 */
@Controller('v1/sellers')
export class SellerVocabularyController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly vocabulary: SellerVocabularyService,
  ) {}

  @Get('me/listings/:slug/attributes')
  async listingAttributes(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<SellerListingAttributesResponse> {
    return this.#attributes(request, slug, 'product', locale);
  }

  @Post('me/listings/:slug/attributes')
  @HttpCode(200)
  async saveListingAttributes(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SaveSellerListingAttributesRequestSchema))
    body: SaveSellerListingAttributesRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    return this.#saveAttributes(request, slug, 'product', body);
  }

  @Get('me/listings/:slug/tags')
  async listingTags(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<SellerListingTagsResponse> {
    return this.#tags(request, slug, 'product', locale);
  }

  @Post('me/listings/:slug/tags')
  @HttpCode(200)
  async saveListingTags(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SaveSellerListingTagsRequestSchema)) body: SaveSellerListingTagsRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    return this.#saveTags(request, slug, 'product', body);
  }

  @Get('me/services/:slug/attributes')
  async serviceAttributes(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<SellerListingAttributesResponse> {
    return this.#attributes(request, slug, 'service', locale);
  }

  @Post('me/services/:slug/attributes')
  @HttpCode(200)
  async saveServiceAttributes(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SaveSellerListingAttributesRequestSchema))
    body: SaveSellerListingAttributesRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    return this.#saveAttributes(request, slug, 'service', body);
  }

  @Get('me/services/:slug/tags')
  async serviceTags(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<SellerListingTagsResponse> {
    return this.#tags(request, slug, 'service', locale);
  }

  @Post('me/services/:slug/tags')
  @HttpCode(200)
  async saveServiceTags(
    @Req() request: SellerVocabularyRequestContext,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(SaveSellerListingTagsRequestSchema)) body: SaveSellerListingTagsRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    return this.#saveTags(request, slug, 'service', body);
  }

  async #attributes(
    request: SellerVocabularyRequestContext,
    slug: string,
    surface: SellerVocabularySurface,
    locale: string | undefined,
  ): Promise<SellerListingAttributesResponse> {
    const userId = await this.#caller(request);
    const found = await this.vocabulary.attributes(userId, slug, surface, publicLocaleOf(locale));
    return { attributes: [...found.attributes], isEditable: found.isEditable };
  }

  async #saveAttributes(
    request: SellerVocabularyRequestContext,
    slug: string,
    surface: SellerVocabularySurface,
    body: SaveSellerListingAttributesRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    const userId = await this.#caller(request);
    await this.vocabulary.saveAttributes(userId, slug, surface, body);
    return { slug, saved: true };
  }

  async #tags(
    request: SellerVocabularyRequestContext,
    slug: string,
    surface: SellerVocabularySurface,
    locale: string | undefined,
  ): Promise<SellerListingTagsResponse> {
    const userId = await this.#caller(request);
    const found = await this.vocabulary.tags(userId, slug, surface, publicLocaleOf(locale));
    return { tags: [...found.tags], isEditable: found.isEditable };
  }

  async #saveTags(
    request: SellerVocabularyRequestContext,
    slug: string,
    surface: SellerVocabularySurface,
    body: SaveSellerListingTagsRequest,
  ): Promise<SellerListingAttributesWriteResponse> {
    const userId = await this.#caller(request);
    await this.vocabulary.saveTags(userId, slug, surface, body.tags);
    return { slug, saved: true };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  async #caller(request: SellerVocabularyRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
