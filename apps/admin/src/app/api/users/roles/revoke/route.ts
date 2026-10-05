import { handleStaffRoleRevoke } from '../../../../../server/bff';

/**
 * `POST /api/users/roles/revoke` (0100).
 *
 * A withdrawal, which is an update and never a delete: the upstream writer records it on the grant's own row
 * with who did it and why. It takes effect on the target's next request, because nothing in this platform ends
 * a session.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleStaffRoleRevoke(request);
}
