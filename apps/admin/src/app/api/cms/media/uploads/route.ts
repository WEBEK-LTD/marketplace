import { handleCmsMediaUploadAuthorize } from '../../../../../server/bff';

/**
 * `POST /api/cms/media/uploads` — authorize one upload.
 *
 * Creates a signed, time-limited permission to put one object at one path, and records nothing. The body carries a
 * content type and a size and **no path**: every component of the path is the server's, which is what makes a chosen
 * path or a traversal unexpressible rather than merely refused.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCmsMediaUploadAuthorize(request);
}
