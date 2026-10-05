import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  CMS_PAGE_SLUG_PATTERN,
  publicLocaleOf,
  type PublicCmsPageLookupResponse,
  type PublicCmsPagesResponse,
} from '@repo/contracts';
import { CmsPagesService } from '../cms/cms-pages.service.js';

/**
 * `GET /v1/cms/pages` and `GET /v1/cms/pages/:slug` — the public CMS pages.
 *
 * Two reads, no user context, no body, no pagination and no sort. The internal BFF credential guard still
 * applies — it covers every `/v1` route by construction — so the browser reaches these through the BFF like
 * everything else.
 *
 * `locale` is not a filter. It selects which language the text comes back in; the set of pages is identical
 * either way, and a page that has not been translated into the requested language comes back in the default
 * one with `resolvedLocale` saying so. An unrecognised or absent locale resolves to the default rather than
 * becoming a 400, for the same reason the category tree does: a client that misspells a language tag should
 * see the page in English, not an error.
 *
 * **The moved answer is a 200, not a 301.** A 301 from this API would be followed transparently by the BFF's
 * `fetch`, which would then hold the renamed page with a 200 and no idea that it should redirect the browser.
 * So the outcome travels in the body, where it cannot be followed by accident, and the BFF turns it into a
 * locale-aware redirect of its own.
 *
 * **The controller decides nothing.** What is published, which locale is returned, whether a slug is a
 * redirect, and the order of the index are all decided in migrations 0030 and 0085. The slug's shape is checked
 * here only so that something which cannot be an address never reaches a parameter binding.
 */
@Controller('v1')
export class CmsPagesController {
  constructor(private readonly pages: CmsPagesService) {}

  /** Every page the public may see, titled in the requested locale. */
  @Get('cms/pages')
  async index(@Query('locale') locale?: string): Promise<PublicCmsPagesResponse> {
    const pages = await this.pages.index(publicLocaleOf(locale));
    return { pages: [...pages] };
  }

  /**
   * One public page, or the slug it moved to.
   *
   * A draft, a schedule, an archive, a page whose publication moment has not arrived, a published page nobody
   * has written and a slug that never existed all share the 404, deliberately: a distinguishable refusal would
   * be a way to ask whether an unpublished page is sitting in the console.
   */
  @Get('cms/pages/:slug')
  async bySlug(
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<PublicCmsPageLookupResponse> {
    // Not an authorization check and not a business rule: a string that cannot be a slug cannot name a page,
    // so it is the same 404 as a slug that names nothing.
    if (!CMS_PAGE_SLUG_PATTERN.test(slug)) throw new NotFoundException();

    const found = await this.pages.bySlug(slug, publicLocaleOf(locale));
    if (found.kind === 'not_found') throw new NotFoundException();
    if (found.kind === 'moved') return { outcome: 'moved', movedTo: found.movedTo };
    return { outcome: 'page', page: found.page };
  }
}
