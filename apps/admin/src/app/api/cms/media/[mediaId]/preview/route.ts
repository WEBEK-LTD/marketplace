import { handleCmsMediaPreview } from '../../../../../../server/bff';

/**
 * `GET /api/cms/media/:mediaId/preview` — a short-lived signed URL for one stored object.
 *
 * Fetched when an operator asks to see an image, not for every row: a signed URL is a bearer credential for a few
 * minutes, and issuing one per row would put live credentials into the HTML of a page nobody has looked at yet.
 * The URL is held in the component's state and is never written into a link.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await context.params;
  return handleCmsMediaPreview(request, mediaId);
}
