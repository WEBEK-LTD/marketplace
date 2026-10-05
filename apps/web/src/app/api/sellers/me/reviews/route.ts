import { handleSellerReviews } from '../../../../../server/bff';

/**
 * `GET /api/sellers/me/reviews` — a read-only seller surface (Phase 6-J).
 *
 * One method and one line. There is no POST, PATCH, PUT or DELETE here and none anywhere in 6-J: these
 * surfaces read, and the handler sets `no-store` because what they read is private to one seller.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerReviews(request);
}
