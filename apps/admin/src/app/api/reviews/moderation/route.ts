import { handleReviewModeration } from '../../../../server/bff';

/**
 * `POST /api/reviews/moderation` (Phase 7-P).
 *
 * The body is rebuilt field by field by the shared handler from the contract’s two fields; a moderator, a
 * timestamp, an automatic hiding reason, a publication time or anything naming the reply, the order or the
 * rating sent alongside them is dropped before anything leaves this origin. Which decisions are legal, and
 * who may not take them, is decided in the database, not here.
 *
 * **There is deliberately no sibling route that moderates a reply.** No writer for a reply’s status exists in
 * this repository, so there is nothing for such a route to call.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleReviewModeration(request);
}
