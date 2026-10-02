import { handleFileReport } from '../../../../server/bff';

/**
 * `POST /api/messaging/reports` — report a message or a conversation (Phase 5-H).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential and the
 * contract validation all live in the shared handler, which the tests drive directly. The middleware
 * already treats the whole `/api/messaging/` family as a BFF route, so this path needed no change there.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFileReport(request);
}
