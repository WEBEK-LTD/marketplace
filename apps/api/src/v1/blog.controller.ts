import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  BLOG_INDEX_DEFAULT_LIMIT,
  BLOG_INDEX_MAX_LIMIT,
  BLOG_SLUG_PATTERN,
  publicLocaleOf,
  type PublicBlogIndexResponse,
  type PublicBlogPostLookupResponse,
  type PublicBlogTaxonomyResponse,
} from '@repo/contracts';
import { BlogPublicService } from '../cms/blog-public.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';

/**
 * `GET /v1/blog`, `GET /v1/blog/taxonomy` and `GET /v1/blog/:slug` — the public blog (0092).
 *
 * Three reads, no user context, no body. The internal BFF credential guard still applies — it covers every
 * `/v1` route by construction — so the browser reaches these through the BFF like everything else.
 *
 * `locale` is not a filter. It selects which language the text comes back in; the set of posts is identical
 * either way, and a post that has not been translated into the requested language comes back in the default one
 * with `resolvedLocale` saying so. An unrecognised or absent locale resolves to the default rather than becoming
 * a 400, for the same reason the category tree does: a client that misspells a language tag should see the post
 * in English, not an error.
 *
 * `category` and `tag` **are** filters, and they are passed through as text. A slug that names nothing, or
 * something deactivated, matches nothing in the database, so a stale link shows an empty page rather than an
 * error — the same choice the category feed makes.
 *
 * **The moved answer is a 200, not a 301.** A 301 from this API would be followed transparently by the BFF's
 * `fetch`, which would then hold the renamed post with a 200 and no idea that it should redirect the browser.
 * So the outcome travels in the body, where it cannot be followed by accident, and the BFF turns it into a
 * locale-aware redirect of its own.
 *
 * **The controller decides nothing.** What is published, which locale is returned, whether a slug is a
 * redirect, and the order of the index are all decided in migrations 0030 and 0092. The shapes checked here — a
 * slug, a limit — exist so that something which cannot be an address or a page size never reaches a parameter
 * binding.
 *
 * **`taxonomy` is declared before `:slug` on purpose.** Nest matches in declaration order, so a route declared
 * after the parameter would be shadowed by it and `/v1/blog/taxonomy` would be read as a post called
 * "taxonomy". The slug pattern would then 404 it, which is a confusing way to lose a working endpoint.
 */
@Controller('v1')
export class BlogController {
  constructor(private readonly blog: BlogPublicService) {}

  /** One page of the public index, newest published first. */
  @Get('blog')
  async index(
    @Query('locale') locale?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<PublicBlogIndexResponse> {
    const page = await this.blog.index({
      locale: publicLocaleOf(locale),
      categorySlug: this.optional(category),
      tagSlug: this.optional(tag),
      limit: this.limit(limit),
      cursor: this.optional(cursor),
    });
    // Null is the service reporting a cursor it could not read. One refusal for malformed, altered and
    // outdated, because the client's remedy is the same in every case.
    if (page === null) {
      throw new RequestValidationException([{ path: 'cursor', message: 'The cursor could not be read.' }]);
    }
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** The filters the index offers, with how many posts the public may see under each. */
  @Get('blog/taxonomy')
  async taxonomy(@Query('locale') locale?: string): Promise<PublicBlogTaxonomyResponse> {
    const taxonomy = await this.blog.taxonomy(publicLocaleOf(locale));
    return { categories: [...taxonomy.categories], tags: [...taxonomy.tags] };
  }

  /**
   * One public post, or the slug it moved to.
   *
   * A draft, a schedule, an archive, a post whose publication moment has not arrived, a published post nobody
   * has written and a slug that never existed all share the 404, deliberately: a distinguishable refusal would
   * be a way to ask whether an unpublished post is sitting in the console.
   */
  @Get('blog/:slug')
  async bySlug(
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<PublicBlogPostLookupResponse> {
    // Not an authorization check and not a business rule: a string that cannot be a slug cannot name a post, so
    // it is the same 404 as a slug that names nothing.
    if (!BLOG_SLUG_PATTERN.test(slug)) throw new NotFoundException();

    const found = await this.blog.bySlug(slug, publicLocaleOf(locale));
    if (found.kind === 'not_found') throw new NotFoundException();
    if (found.kind === 'moved') return { outcome: 'moved', movedTo: found.movedTo };
    return { outcome: 'post', post: found.post };
  }

  /* ---------------------------------------------------------------------------------------------- */

  private limit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return BLOG_INDEX_DEFAULT_LIMIT;
    if (!/^\d{1,4}$/.test(raw)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(raw);
    if (value < 1) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return Math.min(value, BLOG_INDEX_MAX_LIMIT);
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }
}
