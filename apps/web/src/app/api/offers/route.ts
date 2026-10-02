import { handleCreateOffer } from '../../../server/bff';

/**
 * `POST /api/offers` — the browser's only entry to opening an offer (Phase 7-H).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential, the
 * field-by-field body rebuild and the problem-details pass-through all live in the shared handler, which
 * the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCreateOffer(request);
}
