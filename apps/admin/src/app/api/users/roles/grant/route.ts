import { handleStaffRoleGrant } from '../../../../../server/bff';

/**
 * `POST /api/users/roles/grant` (0100).
 *
 * The body is rebuilt field by field by the shared handler from the contract's three fields, so anything else
 * sent alongside them is dropped before it leaves this origin. **Which roles this caller may grant is not
 * decided here and cannot be influenced from here**: the database applies the ceiling, the `super_admin`
 * exclusion, the assignability flag and the self rule against the caller's own effective roles.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleStaffRoleGrant(request);
}
