import { handleSellerMediaAttach } from '../../../../../server/bff';

/**
 * `POST /api/sellers/me/media` — confirm a seller media upload (Phase 6-E).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal credential and both contract
 * validations live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSellerMediaAttach(request);
}
