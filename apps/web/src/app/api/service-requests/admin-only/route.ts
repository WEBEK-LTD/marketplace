import { handleCreateAdminOnlyServiceRequest } from '../../../../server/bff';

/**
 * `POST /api/service-requests/admin-only` — send a brief for the platform to handle (Phase 7-J).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential, the
 * field-by-field body rebuild and the problem-details pass-through all live in the shared handler.
 *
 * The path names the kind of request this creates, not a privilege the caller holds — any signed-in buyer may
 * send one, and the server is what assigns the routing mode.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCreateAdminOnlyServiceRequest(request);
}
