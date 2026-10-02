import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import {
  parseListingsLimit,
  publicLocaleOf,
  type ListingDetailResponse,
  type ListingsResponse,
} from '@repo/contracts';
import { InvalidListingCursorError, ListingsService } from '../catalog/listings.service.js';

/** Fastify's reply, reduced to what a redirect needs. */
interface ListingReplyContext {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  send(payload: unknown): unknown;
}

/**
 * `GET /v1/listings` and `GET /v1/listings/:slug`.
 *
 * Both carry no user context: the browse list and a listing page are the same for a guest and for a
 * signed-in person. The internal BFF credential guard still covers them, like every `/v1` route.
 *
 * The three shapes a slug can resolve to are the three the owner approved: 200 with the listing, 301 to
 * the current slug when an old one was used, and 404 when nothing the public may see answers to it. The
 * 404 is deliberately the same for a listing that never existed, one still in draft, one that was
 * rejected and one whose seller is suspended — a different answer for each would turn this route into a
 * way to enumerate private state.
 */
@Controller('v1')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Get('listings')
  async list(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListingsResponse> {
    const parsed = parseListingsLimit(limit);
    if (!parsed.ok) throw new InvalidListingCursorError();

    const page = await this.listings.page(parsed.limit, cursor === undefined || cursor === '' ? null : cursor);
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('listings/:slug')
  async detail(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) reply: ListingReplyContext,
    @Query('locale') locale?: string,
  ): Promise<ListingDetailResponse | undefined> {
    const found = await this.listings.bySlug(slug, publicLocaleOf(locale));

    if (found.kind === 'moved') {
      // 301 to the canonical URL, as the canonical rule requires. That URL may be on the other surface:
      // a slug naming a service belongs to `/v1/services`, and answering it here would give one listing
      // two public addresses. The BFF turns this into the browser's own redirect; the body is empty
      // because a redirect has nothing to say.
      const base = found.canonicalType === 'service' ? '/v1/services' : '/v1/listings';
      reply.status(301);
      reply.header('location', `${base}/${encodeURIComponent(found.canonicalSlug)}`);
      reply.header('x-canonical-slug', found.canonicalSlug);
      reply.header('x-canonical-type', found.canonicalType);
      return undefined;
    }
    if (found.kind === 'not_found') throw new NotFoundException();

    return { listing: found.listing };
  }
}
