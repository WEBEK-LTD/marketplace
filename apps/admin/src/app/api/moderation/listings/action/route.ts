import { handleModerationListingAction } from '../../../../../server/bff';

/**
 * `POST /api/moderation/listings/action` (Phase 7-N).
 *
 * The body is rebuilt field by field by the shared handler from the contract's three fields. There is no
 * status field, no expiry and no reversal: the status the listing lands on is the database writer's own
 * mapping, and no writer in this repository sets the other two.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleModerationListingAction(request);
}
