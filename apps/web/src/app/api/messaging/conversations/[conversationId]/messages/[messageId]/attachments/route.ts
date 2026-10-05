import { handleRecordMessageAttachment } from '../../../../../../../../server/bff';

/**
 * `POST /api/messaging/conversations/:conversationId/messages/:messageId/attachments` (0104).
 *
 * Step three. The API asks storage whether the object arrived before the row is written, so a row can never
 * describe a file that is not there.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
): Promise<Response> {
  const { conversationId, messageId } = await context.params;
  return handleRecordMessageAttachment(request, conversationId, messageId);
}
