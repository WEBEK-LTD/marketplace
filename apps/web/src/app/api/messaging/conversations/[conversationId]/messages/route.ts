import { handleConversationMessages, handleSendMessage } from '../../../../../../server/bff';

/**
 * `GET /api/messaging/conversations/:conversationId/messages` — one page of one conversation.
 *
 * The identifier is a route parameter rather than a query field, so the browser's URL matches the API's.
 * It is not validated here: the API refuses a malformed one, and a second copy of that rule is a second
 * thing that can disagree.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleConversationMessages(request, conversationId);
}

/** `POST /api/messaging/conversations/:conversationId/messages` — send one text message (5-E). */
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleSendMessage(request, conversationId);
}
