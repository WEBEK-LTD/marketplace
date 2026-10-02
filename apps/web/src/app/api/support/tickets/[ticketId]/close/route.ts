import { handleCloseSupportTicket } from '../../../../../../server/bff';

/**
 * `POST /api/support/tickets/:ticketId/close` (Phase 7-K).
 *
 * The operation names the one move it makes, so nothing about a status crosses. Whatever a page puts in the body
 * is dropped by the shared handler, which sends none.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const { ticketId } = await context.params;
  return handleCloseSupportTicket(request, ticketId);
}
