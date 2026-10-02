import { handleUpdateProfile } from '../../../../server/bff';

/**
 * `PATCH /api/account/profile` — edit the four fields a person owns (Phase 7-E).
 *
 * A phone number is changed through the verified contact-change flow and nowhere else; a status and a
 * role are not writable from any browser path at all.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request): Promise<Response> {
  return handleUpdateProfile(request);
}
