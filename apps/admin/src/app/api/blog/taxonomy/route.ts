import { handleBlogTaxonomySave } from '../../../../server/bff';

/**
 * `POST /api/blog/taxonomy` — create or replace one blog category or tag.
 *
 * One route for four upstream operations, chosen by the `kind` the body names and whether it carries an `entryId`.
 * Four browser routes would mean four same-origin checks and four copies of the same validation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleBlogTaxonomySave(request);
}
