import { handleSupportRelease } from '../../../../server/bff';

/**
 * `POST /api/support/release` (Phase 7-L).
 *
 * Returns a ticket the caller holds to the shared queue. It changes no status: the existing writer's null
 * branch moves the assignee and nothing else.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSupportRelease(request);
}
