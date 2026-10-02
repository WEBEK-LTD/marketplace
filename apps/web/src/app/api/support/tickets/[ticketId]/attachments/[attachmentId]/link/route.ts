import { handleSupportAttachmentLink } from '../../../../../../../../server/bff';

/**
 * `GET /api/support/tickets/:ticketId/attachments/:attachmentId/link` (Phase 7-K).
 *
 * One short-lived authorization to look at one file. A link cannot be rendered into a page — it expires in
 * minutes — so it is fetched when somebody asks for it, and the API refuses an attachment that does not
 * belong to the ticket in the route.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ ticketId: string; attachmentId: string }> },
): Promise<Response> {
  const { ticketId, attachmentId } = await context.params;
  return handleSupportAttachmentLink(request, ticketId, attachmentId);
}
