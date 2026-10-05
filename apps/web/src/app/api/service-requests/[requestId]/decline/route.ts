import { handleDeclineServiceRequest } from '../../../../../server/bff';

/**
 * `POST /api/service-requests/:requestId/decline` (Phase 7-I).
 *
 * The identifier is a route parameter and nothing more: it is checked for shape by the shared handler, and
 * which side of the exchange may take this step is decided in the database from the caller's own account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params;
  return handleDeclineServiceRequest(request, requestId);
}
