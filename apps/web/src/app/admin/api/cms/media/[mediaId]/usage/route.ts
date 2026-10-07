import { handleCmsMediaUsage } from '../../../../../../../admin/server/bff';

/**
 * `GET /admin/api/cms/media/:mediaId/usage` — every CMS row that points at one entry.
 *
 * What the screen reads before it offers to delete anything. All six referencing columns are `on delete set null`, so
 * an operator has to be able to see what deleting would blank rather than discover it afterwards.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await context.params;
  return handleCmsMediaUsage(request, mediaId);
}
