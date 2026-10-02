import { handleRegisterResend } from '../../../../../server/bff';

/** `POST /api/auth/register/resend` — asks for the verification code again. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRegisterResend(request);
}
