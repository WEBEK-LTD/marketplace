import {
  handleSellerIdentity,
  handleSellerOnboarding,
  handleSellerProfileUpdate,
} from '../../../../server/bff';

/**
 * `GET /api/sellers/me` — the caller's own seller identity (Phase 6-A).
 *
 * Three lines on purpose: the session cookie, the internal BFF credential and the contract validation all
 * live in the shared handler, which the tests drive directly. The middleware already treats
 * `/api/sellers/` as a BFF prefix, so this path needed no change there, and `/api/sellers/[slug]` is
 * untouched — a static segment wins over the dynamic one in Next's router.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSellerIdentity(request);
}

/**
 * `POST /api/sellers/me` — create the caller's own storefront (Phase 6-C).
 *
 * Same three lines, same shared handler: the Origin check, the session cookie, the internal credential and
 * both contract validations live there. The middleware already treats `/api/sellers/` as a BFF prefix, so
 * this needed no routing change either, and the GET above is untouched.
 */
export async function POST(request: Request): Promise<Response> {
  return handleSellerOnboarding(request);
}

/**
 * `PATCH /api/sellers/me` — edit the caller's own storefront (Phase 6-D).
 *
 * Same shared handler, same conventions; the GET and the POST above are untouched.
 */
export async function PATCH(request: Request): Promise<Response> {
  return handleSellerProfileUpdate(request);
}
