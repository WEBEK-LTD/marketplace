import { handleSeller } from '../../../../server/bff';

/**
 * `GET /api/sellers/:slug` — one public seller profile, or a 404.
 *
 * `dynamic = 'force-dynamic'` because a seller's status can change at any moment and C11 makes
 * moderation-sensitive responses non-cacheable; a cached page could present a suspended seller as live.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSeller(request, slug);
}
