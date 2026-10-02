import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import {
  parseServicesLimit,
  publicLocaleOf,
  type ServiceDetailResponse,
  type ServicesResponse,
} from '@repo/contracts';
import { InvalidListingCursorError } from '../catalog/listings.service.js';
import { ServicesService } from '../catalog/services.service.js';

/** Fastify's reply, reduced to what a redirect needs. */
interface ServiceReplyContext {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  send(payload: unknown): unknown;
}

/**
 * `GET /v1/services` and `GET /v1/services/:slug`.
 *
 * Both carry no user context: the service list and a service page are the same for a guest and for a
 * signed-in person. The internal BFF credential guard still covers them, like every `/v1` route.
 *
 * A slug names one listing out of a single namespace shared with products, so this route answers for
 * services and redirects for everything else it can see: a product's slug is a 301 to `/v1/listings`,
 * a previous slug is a 301 to the current one, and anything the public may not see is the same 404
 * whether it is a draft, a rejected service or a slug that never existed.
 */
@Controller('v1')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get('services')
  async list(@Query('limit') limit?: string, @Query('cursor') cursor?: string): Promise<ServicesResponse> {
    const parsed = parseServicesLimit(limit);
    if (!parsed.ok) throw new InvalidListingCursorError();

    const page = await this.services.page(parsed.limit, cursor === undefined || cursor === '' ? null : cursor);
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get('services/:slug')
  async detail(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) reply: ServiceReplyContext,
    @Query('locale') locale?: string,
  ): Promise<ServiceDetailResponse | undefined> {
    const found = await this.services.bySlug(slug, publicLocaleOf(locale));

    if (found.kind === 'moved') {
      const base = found.canonicalType === 'service' ? '/v1/services' : '/v1/listings';
      reply.status(301);
      reply.header('location', `${base}/${encodeURIComponent(found.canonicalSlug)}`);
      reply.header('x-canonical-slug', found.canonicalSlug);
      reply.header('x-canonical-type', found.canonicalType);
      return undefined;
    }
    if (found.kind === 'not_found') throw new NotFoundException();

    return { service: found.service };
  }
}
