import { handleMarkRead } from '../../../../../../server/bff';

/**
 * `PUT /api/messaging/conversations/:conversationId/read` — move the caller's own read marker.
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential and the
 * contract validation all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleMarkRead(request, conversationId);
}
