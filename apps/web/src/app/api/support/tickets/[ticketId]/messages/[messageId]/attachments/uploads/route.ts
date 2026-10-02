import { handleAuthorizeSupportAttachment } from '../../../../../../../../../server/bff';

/**
 * `POST /api/support/tickets/:ticketId/messages/:messageId/attachments/uploads` (Phase 7-K).
 *
 * Asks for somewhere to put one file. The destination comes back from this call; the request carries no
 * path, and the strict contract behind the handler has no field for one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ ticketId: string; messageId: string }> },
): Promise<Response> {
  const { ticketId, messageId } = await context.params;
  return handleAuthorizeSupportAttachment(request, ticketId, messageId);
}
