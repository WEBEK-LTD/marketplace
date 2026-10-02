import { handleFileSubjectReport } from '../../../server/bff';

/**
 * `POST /api/reports` (Phase 7-M).
 *
 * The body is rebuilt field by field by the shared handler from the contract's four fields; a reporter, a
 * subject id, a status, a priority, an assignee or a resolution sent alongside them is dropped before
 * anything leaves this origin.
 *
 * There is no `GET` here. The reporter's own history is read by the server component that renders it, so a
 * browser has no route through which to ask for a list at all.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFileSubjectReport(request);
}
