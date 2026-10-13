import { handleListingMediaAttach, handleListingMediaList } from '../../../../../server/bff';

/**
 * `/api/listings/:slug/media` — a listing's photographs (0116).
 *
 * `GET` reads them, including the unpublished ones a draft has, for whoever may manage them. `POST` is the
 * confirmation step: it records four uploaded objects as one photograph. Both are `no-store`, both require
 * the caller's own session, and neither is reachable for a listing the caller may not manage.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleListingMediaList(request, slug);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleListingMediaAttach(request, slug);
}
