import { handleRecoveryVerify } from '../../../../../server/bff';

/**
 * `POST /api/auth/recovery/verify` — the browser's only entry to this step of the reset flow.
 *
 * Three lines on purpose: the Origin check, the internal BFF credential, the cookie rules and the
 * problem-details pass-through all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRecoveryVerify(request);
}
