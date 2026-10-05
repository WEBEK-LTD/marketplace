import { handleDisputeMessage } from '../../../../server/bff';

/**
 * `POST /api/disputes/messages` (Phase 7-R).
 *
 * The body is rebuilt field by field by the shared handler from the contract’s two fields; an author, a role,
 * a timestamp or anything naming the order is dropped before anything leaves this origin. Which author role a
 * message is recorded under is decided in the database, from the dispute itself, not here.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDisputeMessage(request);
}
