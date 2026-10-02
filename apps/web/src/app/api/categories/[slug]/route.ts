import { handleCategory } from '../../../../server/bff';

/**
 * `GET /api/categories/:slug` — one public category, or a 404.
 *
 * `dynamic = 'force-dynamic'` because a category's active state can change at any moment and C11 makes
 * moderation-sensitive responses non-cacheable; a cached page could offer a withdrawn category.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleCategory(request, slug);
}
