import { handleCreateServiceQuote } from '../../../../../server/bff';

/**
 * `POST /api/service-requests/:requestId/quotes` — the seller answers one brief (Phase 7-I).
 *
 * The brief is the route parameter; there is no field in the body that could name a different one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params;
  return handleCreateServiceQuote(request, requestId);
}
