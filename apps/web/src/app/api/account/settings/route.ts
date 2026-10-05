import { handleUpdateSettings } from '../../../../server/bff';

/** `PUT /api/account/settings` — a whole-state write of the caller's own settings (Phase 7-E). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleUpdateSettings(request);
}
