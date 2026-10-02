import { handleTotpStatus } from '../../../../server/bff';

/** `GET /api/auth/totp` on the admin origin — whether the caller has an authenticator. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleTotpStatus(request);
}
