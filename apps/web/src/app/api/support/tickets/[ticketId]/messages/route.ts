import { handlePostSupportMessage } from '../../../../../../server/bff';

/**
 * `POST /api/support/tickets/:ticketId/messages` (Phase 7-K).
 *
 * The identifier is a route parameter and nothing more: it is checked for shape by the shared handler, and
 * whether the ticket is the caller's is decided in the database from their own session.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const { ticketId } = await context.params;
  return handlePostSupportMessage(request, ticketId);
}
