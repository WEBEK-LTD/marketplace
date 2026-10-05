import { handleSellerListingCreate, handleSellerListings } from '../../../../../server/bff';

/**
 * `/api/sellers/me/listings` — the caller's own listings (Phase 6-F).
 *
 * Two lines each on purpose: the session cookie, the Origin check, the internal BFF credential and both
 * contract validations live in the shared handlers, which the tests drive directly. The middleware already
 * treats `/api/sellers/` as a BFF prefix, so this path needed no change there, and `/api/sellers/me`,
 * `/api/sellers/me/media` and `/api/sellers/[slug]` are all untouched — a static segment wins over the
 * dynamic one in Next's router.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerListings(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSellerListingCreate(request);
}
