import { handleTotpVerify } from '../../../../../../admin/server/bff';

/** `POST /api/auth/totp/verify` on the admin origin. The rules live in the shared handler. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleTotpVerify(request);
}
