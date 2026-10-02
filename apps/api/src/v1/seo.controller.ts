import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  REDIRECT_FROM_PATH_PATTERN,
  REDIRECT_PATH_MAX,
  SITEMAP_API_ENTRY_TYPES,
  type RedirectResolutionResponse,
  type RobotsSettingsResponse,
  type SitemapApiEntryType,
  type SitemapCountsResponse,
  type SitemapPageResponse,
} from '@repo/contracts';
import { SeoService } from '../seo/seo.service.js';

/**
 * `GET /v1/seo/robots`, `GET /v1/seo/sitemap` and `GET /v1/seo/sitemap/:type/:page` — what the public web
 * builds `robots.txt` and the sitemaps from.
 *
 * Three reads. No user context, no body, no cursor, no sort to choose. The internal BFF credential guard still
 * applies, because it covers every `/v1` route by construction, so these are reached through the BFF like
 * everything else — a crawler talks to the web app, never to this API.
 *
 * **The controller decides nothing about content.** What belongs in a sitemap is decided by the named readers
 * of migration 0086, which call the same predicates the public pages resolve through: purchasable rather than
 * merely public for a listing, every ancestor active for a category, published and written for a page. All this
 * controller does is refuse a path that cannot name anything, and even then it refuses the *shape* and not the
 * content — an unknown kind of address is a 400 because there is no such sitemap, not because something is
 * hidden behind it.
 *
 * **A page past the end is an empty page, not a 404.** The index a crawler is following may be minutes old and
 * the set may have shrunk since; answering "nothing here" is both true and harmless, while a 404 on a sitemap a
 * live index still names is a broken site.
 */
@Controller('v1/seo')
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  /**
   * Where the admin redirect map sends one path, or that it names no redirect for it.
   *
   * **Asked only about a path the public web has already decided answers 404.** The approved precedence is LIVE
   * PAGE WINS, and it is resolved in the web app's own request path, before this is reached — so an active entry
   * can never shadow a live catalogue URL, and nothing in this API could make it.
   *
   * A path that cannot be an incoming path at all is a 400. A path the map does not name is `none` with a 200,
   * because "no redirect" is the common answer and must be distinguishable from this service being unreachable:
   * a caller that could not tell those apart would have to choose between swallowing an outage and refusing to
   * serve a 404 page that was perfectly correct.
   */
  @Get('redirects/resolve')
  async resolveRedirect(@Query('path') path?: string): Promise<RedirectResolutionResponse> {
    return await this.seo.resolveRedirect(incomingPathOf(path));
  }

  /** The authored robots body, or nulls when nobody has authored one. */
  @Get('robots')
  async robots(): Promise<RobotsSettingsResponse> {
    const { locale, body } = await this.seo.robots();
    return { locale: locale === 'ar' ? 'ar' : locale === 'en' ? 'en' : null, body };
  }

  /** How many entries each kind of address would produce, for the sitemap index. */
  @Get('sitemap')
  async counts(): Promise<SitemapCountsResponse> {
    const { pageSize, counts } = await this.seo.sitemapCounts();
    return { pageSize, counts: [...counts] };
  }

  /** One page of entries of one kind. */
  @Get('sitemap/:type/:page')
  async page(@Param('type') type: string, @Param('page') page: string): Promise<SitemapPageResponse> {
    const found = await this.seo.sitemapPage(kindOf(type), pageNumberOf(page));
    return {
      ...found,
      entries: found.entries.map((entry) => ({
        slug: entry.slug,
        updatedAt: entry.updatedAt,
        ...(entry.locales === undefined ? {} : { locales: [...entry.locales] }),
      })),
    };
  }
}

/**
 * A path the map could conceivably name, or a 400.
 *
 * The shape is 0030's `redirects_from_path_is_relative` constraint, restated: a relative path that does not begin
 * with a second slash. Anything else cannot be a row in the table, so asking about it is a malformed request
 * rather than a question with the answer "no" — and refusing it here keeps a value that is not a path out of a
 * parameter binding.
 */
function incomingPathOf(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > REDIRECT_PATH_MAX) throw new BadRequestException();
  if (!REDIRECT_FROM_PATH_PATTERN.test(value)) throw new BadRequestException();
  return value;
}

/** One of the kinds this API enumerates, or a 400. The fixed landing routes are the web app's own. */
function kindOf(value: string): SitemapApiEntryType {
  const found = SITEMAP_API_ENTRY_TYPES.find((type) => type === value);
  if (found === undefined) throw new BadRequestException();
  return found;
}

/**
 * A 1-based page number, or a 400.
 *
 * Checked rather than coerced: `Number('')` is zero and `parseInt('3x')` is three, and either would quietly
 * serve the wrong page of a document a crawler then treats as the whole truth. An out-of-range page is a
 * different matter and is answered empty — this refuses only what is not a page number at all.
 */
function pageNumberOf(value: string): number {
  if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new BadRequestException();
  return Number(value);
}
