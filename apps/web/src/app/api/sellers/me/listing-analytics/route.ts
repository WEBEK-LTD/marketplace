import { handleSellerListingAnalytics } from '../../../../../server/bff';

/**
 * `GET /api/sellers/me/listing-analytics` — a read-only seller surface (0102).
 *
 * One method and one line, like every 6-J surface: there is no POST, PATCH, PUT or DELETE here and none
 * anywhere in 0102, because nothing in this increment writes. The handler sets `no-store` because what it
 * reads is private to one seller.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerListingAnalytics(request);
}
