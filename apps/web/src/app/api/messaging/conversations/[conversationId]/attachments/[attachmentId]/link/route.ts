import { handleMessageAttachmentLink } from '../../../../../../../../server/bff';

/**
 * `GET /api/messaging/conversations/:conversationId/attachments/:attachmentId/link` (0104).
 *
 * A ten-minute signed read of one object. The caller names an attachment; the path comes out of the row, so the
 * URL is always for that one file and never cached anywhere.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string; attachmentId: string }> },
): Promise<Response> {
  const { conversationId, attachmentId } = await context.params;
  return handleMessageAttachmentLink(request, conversationId, attachmentId);
}
