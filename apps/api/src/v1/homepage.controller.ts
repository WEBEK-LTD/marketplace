import { Controller, Get, Query } from '@nestjs/common';
import { publicLocaleOf, type PublicHomepageResponse } from '@repo/contracts';
import { HomepagePublicService } from '../cms/homepage-public.service.js';

/**
 * `GET /v1/homepage` — the public homepage, assembled (0093).
 *
 * One read, no user context, no body, no pagination. The internal BFF credential guard still applies — it covers
 * every `/v1` route by construction — so the browser reaches this through the BFF like everything else.
 *
 * `locale` selects a representation and never a subset: the same sections come back in either language, titled
 * and worded in the one that was asked for, with English as the fallback where no Arabic text was written. An
 * unrecognised or absent locale resolves to the default rather than becoming a 400.
 *
 * **An empty `sections` array is a real answer**, not a 404: a marketplace whose administrator has composed
 * nothing yet has a homepage, and it is the one the web app renders without any sections. A 404 here would turn a
 * fresh install into a broken site.
 *
 * **The controller decides nothing.** Which sections are active, which rows they can still show and what order
 * they appear in are all decided in migrations 0030 and 0093; whether a section has anything left to show is
 * decided in the service, once.
 */
@Controller('v1')
export class HomepageController {
  constructor(private readonly homepage: HomepagePublicService) {}

  @Get('homepage')
  async compose(@Query('locale') locale?: string): Promise<PublicHomepageResponse> {
    const sections = await this.homepage.compose(publicLocaleOf(locale));
    return { sections: [...sections] };
  }
}
