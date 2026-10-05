import { handleInbox, handleStartConversation } from '../../../../server/bff';

/**
 * `GET /api/messaging/conversations` — one page of the caller's inbox.
 *
 * Three lines on purpose: the session cookie, the internal BFF credential, the contract validation and
 * the problem-details refusals all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleInbox(request);
}

/** `POST /api/messaging/conversations` — start a conversation, or resolve to the open one (5-E). */
export async function POST(request: Request): Promise<Response> {
  return handleStartConversation(request);
}
