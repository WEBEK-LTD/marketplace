import { handleSellerServiceCreate, handleSellerServices } from '../../../../../server/bff';

/**
 * `/api/sellers/me/services` — the caller's own services (Phase 6-G).
 *
 * Two lines each: the session cookie, the Origin check, the internal BFF credential and both contract
 * validations live in the shared handlers, which the tests drive directly. The middleware already treats
 * `/api/sellers/` as a BFF prefix, so this path needed no change there, and `/api/sellers/me`,
 * `/api/sellers/me/media`, `/api/sellers/me/listings` and `/api/sellers/[slug]` are all untouched.
 *
 * There is no submission or archive route here: a service is submitted and archived through the listing
 * routes, which move the same row.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerServices(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSellerServiceCreate(request);
}
