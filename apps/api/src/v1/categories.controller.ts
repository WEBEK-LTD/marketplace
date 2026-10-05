import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import {
  parseCatalogFilters,
  parseSearchLimit,
  publicLocaleOf,
  type CategoriesResponse,
  type CategoryDetailResponse,
  type CategoryFeedResponse,
} from '@repo/contracts';
import { CategoriesService } from '../catalog/categories.service.js';
import { CategoryFeedService } from '../catalog/category-feed.service.js';
import { InvalidListingCursorError } from '../catalog/listings.service.js';
import { queryParameters, type QueryBearingRequest } from './query-parameters.js';

/**
 * `GET /v1/categories`.
 *
 * The public category tree, and the first `/v1` route that carries no user context at all: a guest and a
 * signed-in person get the same answer. The internal BFF credential guard still applies — it covers
 * every `/v1` route by construction — so the browser reaches this through the BFF like everything else,
 * and never through Supabase directly.
 *
 * There is no request body, no pagination, no filter and no sort. `locale` is not a filter: it selects
 * which language the names come back in, and the set of categories is identical either way.
 *
 * An unrecognised or absent locale resolves to the default rather than becoming a 400. The approved
 * status set for this endpoint is 200, 500 and 503, and a client that misspells a language tag should
 * see the catalogue in English, not an error.
 */
@Controller('v1')
export class CategoriesController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly feed: CategoryFeedService,
  ) {}

  @Get('categories')
  async list(@Query('locale') locale?: string): Promise<CategoriesResponse> {
    const categories = await this.categories.tree(publicLocaleOf(locale));
    return { categories: [...categories] };
  }

  /**
   * One public category.
   *
   * There is no 301 here: categories keep no slug history, so a slug either names a category the public
   * may see or it does not. An inactive category and one that never existed share the 404, deliberately.
   */
  @Get('categories/:slug')
  async detail(
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<CategoryDetailResponse> {
    const found = await this.categories.bySlug(slug, publicLocaleOf(locale));
    if (found.kind === 'not_found') throw new NotFoundException();
    return { category: found.category, seo: found.seo };
  }
  /**
   * `GET /v1/categories/:slug/listings` — what is in a category, and what could narrow it.
   *
   * **Rollup, by owner decision**: the listings of this category and of every active category beneath it,
   * inside the three levels D8 allows. A deactivated category takes its branch with it, so hiding one can
   * only ever show a visitor less.
   *
   * The slug is resolved in the database, which also decides visibility, so a category that does not exist,
   * one that is switched off and one under a switched-off ancestor are the same empty answer here — the
   * surface cannot be used to learn that a hidden category exists. An empty page is not a 404: a real but
   * empty shelf is a real place, and the facets tell the surfaces above which empty they are looking at.
   *
   * A **malformed** filter is a 400. A well-formed filter naming nothing real is not: it returns no results,
   * because answering the narrower question a visitor did not ask would be the one failure that shows more
   * than they chose.
   */
  @Get('categories/:slug/listings')
  async listings(
    @Req() request: QueryBearingRequest,
    @Param('slug') slug: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('locale') locale?: string,
  ): Promise<CategoryFeedResponse> {
    const parsedLimit = parseSearchLimit(limit);
    if (!parsedLimit.ok) throw new InvalidListingCursorError();

    const filters = parseCatalogFilters(queryParameters(request));
    if (!filters.ok) throw new InvalidListingCursorError();

    const page = await this.feed.page({
      slug,
      locale: publicLocaleOf(locale),
      filters: filters.filters,
      limit: parsedLimit.limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor, facets: [...page.facets] };
  }
}
