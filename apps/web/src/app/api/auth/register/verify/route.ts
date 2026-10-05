import { handleRegisterVerify } from '../../../../../server/bff';

/** `POST /api/auth/register/verify` — confirms the new account's contact. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRegisterVerify(request);
}
