import { handleAcceptOffer } from '../../../../../server/bff';

/**
 * `POST /api/offers/:offerId/accept` (Phase 7-H).
 *
 * The identifier is a route parameter and nothing more: it is checked for shape by the shared handler, and
 * which side of the negotiation may make this move is decided in the database from the caller's own
 * account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  const { offerId } = await context.params;
  return handleAcceptOffer(request, offerId);
}
