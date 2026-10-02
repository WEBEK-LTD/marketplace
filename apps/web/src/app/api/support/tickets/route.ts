import { handleOpenSupportTicket } from '../../../../server/bff';

/**
 * `POST /api/support/tickets` (Phase 7-K).
 *
 * The body is rebuilt field by field by the shared handler from the contract's three fields; a priority, a
 * status, an assignee or an account sent alongside them is dropped before anything leaves this origin.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleOpenSupportTicket(request);
}
