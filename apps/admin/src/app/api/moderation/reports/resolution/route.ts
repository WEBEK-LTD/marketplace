import { handleModerationReportResolution } from '../../../../../server/bff';

/**
 * `POST /api/moderation/reports/resolution` (Phase 7-N).
 *
 * The body is rebuilt field by field by the shared handler from the contract's three fields; a moderator, a
 * priority, an assignee or a resolver sent alongside them is dropped before anything leaves this origin.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleModerationReportResolution(request);
}
