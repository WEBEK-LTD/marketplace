import { handleRecordSupportAttachment } from '../../../../../../../../server/bff';

/**
 * `POST /api/support/tickets/:ticketId/messages/:messageId/attachments` (Phase 7-K).
 *
 * Confirms the upload at the path the previous call issued. The database rebuilds the expected prefix from
 * the caller's own ticket and message, so a path this route forwards can only be recorded if it is one the
 * server itself could have issued to them.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ ticketId: string; messageId: string }> },
): Promise<Response> {
  const { ticketId, messageId } = await context.params;
  return handleRecordSupportAttachment(request, ticketId, messageId);
}
