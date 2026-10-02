import { handleSellerVerificationSubmit } from '../../../../../../server/bff';

/**
 * `POST /api/sellers/me/verification/submission` — submit for review (Phase 6-I).
 *
 * Its own route rather than a field on the attempt, and it sends no body upstream: a status a browser could
 * put in a body would be a status the browser chose.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSellerVerificationSubmit(request);
}
