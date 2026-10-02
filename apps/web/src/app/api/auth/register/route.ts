import { handleRegister } from '../../../../server/bff';

/**
 * `POST /api/auth/register` — the browser's only entry to registration.
 *
 * Three lines on purpose: the Origin check, the internal BFF credential, the challenge cookie and the
 * problem-details pass-through all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRegister(request);
}
