import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { SellerProfileResponse } from '@repo/contracts';
import { SellersService } from '../catalog/sellers.service.js';

/**
 * `GET /v1/sellers/:slug`.
 *
 * Carries no user context: a seller's public profile is the same for everyone. The internal BFF
 * credential guard still covers it, like every `/v1` route.
 *
 * Three outcomes become two statuses. A suspended seller is a 200 with `availability: 'unavailable'`,
 * because the page exists and says so; a pending seller, a closed seller and a slug that names nobody
 * are one 404 with an identical body, so the route cannot be used to enumerate seller states. There is
 * no 301 here — sellers keep no slug history, so an old slug simply names nobody.
 */
@Controller('v1')
export class SellersController {
  constructor(private readonly sellers: SellersService) {}

  @Get('sellers/:slug')
  async detail(@Param('slug') slug: string): Promise<SellerProfileResponse> {
    const found = await this.sellers.bySlug(slug);
    if (found.kind === 'not_found') throw new NotFoundException();
    return { seller: found.seller, availability: found.availability };
  }
}
