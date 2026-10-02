import { handleCreateServiceRequest } from '../../../server/bff';

/**
 * `POST /api/service-requests` — the browser's only entry to sending a brief (Phase 7-I).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential, the
 * field-by-field body rebuild and the problem-details pass-through all live in the shared handler, which
 * the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCreateServiceRequest(request);
}
