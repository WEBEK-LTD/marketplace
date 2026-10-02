import { handleSellerMediaUpload } from '../../../../../../server/bff';

/**
 * `POST /api/sellers/me/media/uploads` — authorize one seller media upload (Phase 6-E).
 *
 * The response carries a short-lived signed upload URL. It is passed to the browser that asked for it and
 * kept nowhere: not in a log, not in a cache — the handler sets `no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSellerMediaUpload(request);
}
