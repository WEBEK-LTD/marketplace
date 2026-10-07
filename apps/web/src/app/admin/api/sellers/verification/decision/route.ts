import { handleVerificationDecision } from '../../../../../../admin/server/bff';

/**
 * `POST /admin/api/sellers/verification/decision` — approve or reject one application (Phase 7-G).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential and the
 * field-by-field body rebuild all live in the shared handler, which the tests drive directly. The write
 * itself is the API operation that performs 0009's own reviewer UPDATE.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleVerificationDecision(request);
}
