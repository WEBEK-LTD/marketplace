import { handleAuthorizeMessageAttachment } from '../../../../../../../../../server/bff';

/**
 * `POST /api/messaging/conversations/:conversationId/messages/:messageId/attachments/uploads` (0104).
 *
 * Step one of three. Nothing is recorded: the database decides whether this caller may attach and composes the
 * one object path the signature is bound to.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
): Promise<Response> {
  const { conversationId, messageId } = await context.params;
  return handleAuthorizeMessageAttachment(request, conversationId, messageId);
}
