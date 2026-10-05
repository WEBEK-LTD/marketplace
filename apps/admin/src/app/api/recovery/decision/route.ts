import { handleRecoveryDecision } from '../../../../server/bff';

/**
 * `POST /api/recovery/decision` (Phase 7-O).
 *
 * The body is rebuilt field by field by the shared handler from the contract\u2019s two fields; an approver or a status sent alongside them is dropped before anything leaves this origin.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRecoveryDecision(request);
}
