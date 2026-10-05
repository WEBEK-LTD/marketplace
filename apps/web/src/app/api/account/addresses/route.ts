import { handleCreateAddress } from '../../../../server/bff';

/**
 * `POST /api/account/addresses` — add an address (Phase 7-E).
 *
 * Nothing here reaches checkout or an order: shipping is Phase 8, and an address on this surface is a
 * record the person keeps about themselves.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCreateAddress(request);
}
