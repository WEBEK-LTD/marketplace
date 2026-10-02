import { handleServices } from '../../../server/bff';

/**
 * `GET /api/services` — one page of the public service list.
 *
 * `dynamic = 'force-dynamic'` because a service's published state can change at any moment and C11
 * makes moderation-sensitive responses non-cacheable; a cached page could offer a withdrawn service.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleServices(request);
}
