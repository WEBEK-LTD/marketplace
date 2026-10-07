import { handleSupportNote } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/support/note` (Phase 7-L).
 *
 * One internal note, for colleagues only. It lands in the staff-only table that no requester surface in this
 * repository can read.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSupportNote(request);
}
