import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  parseCatalogFilters,
  parseSearchLimit,
  parseSearchQuery,
  publicLocaleOf,
  type SearchResponse,
} from '@repo/contracts';
import { InvalidListingCursorError } from '../catalog/listings.service.js';
import { SearchService } from '../catalog/search.service.js';
import { queryParameters, type QueryBearingRequest } from './query-parameters.js';

/**
 * `GET /v1/search`.
 *
 * Carries no user context: the same query returns the same public results to everyone. The internal BFF
 * credential guard still covers it, like every `/v1` route.
 *
 * `q` is required and must survive trimming with at least two characters. An empty or one-character
 * query is a 400, never a silent browse feed — answering "everything" to a question nobody asked is
 * worse than refusing, and it would also be an expensive query to run by accident.
 *
 * **The filters are 8-D's shared ones**, read from the whole query string rather than from named parameters,
 * because a dimension arrives repeated (`tag=a&tag=b`) and an attribute arrives under a name only the
 * vocabulary knows (`attr.material=oak`). A **malformed** filter is a 400; a well-formed one naming nothing
 * real is not — the database answers that with no results, which is the only reading under which a filter
 * cannot widen what it was given.
 */
@Controller('v1')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('search')
  async run(
    @Req() request: QueryBearingRequest,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('locale') locale?: string,
  ): Promise<SearchResponse> {
    const query = parseSearchQuery(q);
    if (!query.ok) throw new InvalidListingCursorError();

    const parsedLimit = parseSearchLimit(limit);
    if (!parsedLimit.ok) throw new InvalidListingCursorError();

    const filters = parseCatalogFilters(queryParameters(request));
    if (!filters.ok) throw new InvalidListingCursorError();

    const page = await this.search.search({
      query: query.query,
      locale: publicLocaleOf(locale),
      filters: filters.filters,
      limit: parsedLimit.limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }
}
