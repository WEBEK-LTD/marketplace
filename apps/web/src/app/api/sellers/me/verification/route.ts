import {
  handleSellerVerification,
  handleSellerVerificationStart,
} from '../../../../../server/bff';

/**
 * `/api/sellers/me/verification` — the caller's own verification attempt (Phase 6-I).
 *
 * Two lines each: the session cookie, the Origin check on the write, the internal BFF credential and both
 * contract validations live in the shared handlers, which the tests drive directly. The middleware already
 * treats `/api/sellers/` as a BFF prefix, so this path needed no change there, and `/api/sellers/me`,
 * `/api/sellers/me/media`, `/api/sellers/me/listings`, `/api/sellers/me/services` and `/api/sellers/[slug]`
 * are all untouched.
 *
 * There is no PATCH, PUT or DELETE here. An attempt is started and submitted; it is never edited wholesale,
 * and a seller cannot withdraw one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerVerification(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSellerVerificationStart(request);
}
