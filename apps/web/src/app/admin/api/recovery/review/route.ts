import { handleRecoveryReview } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/recovery/review` (Phase 7-O).
 *
 * The body is rebuilt field by field by the shared handler from the contract\u2019s one field; a reviewer or a status sent alongside it is dropped before anything leaves this origin.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRecoveryReview(request);
}
