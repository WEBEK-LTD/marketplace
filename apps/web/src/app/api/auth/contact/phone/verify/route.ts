import { handleContactPhoneVerify } from '../../../../../../server/bff';

/**
 * `POST /api/auth/contact/phone/verify` — the browser's only entry to this step of the phone change.
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential and the
 * problem-details pass-through all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleContactPhoneVerify(request);
}
