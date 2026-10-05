import { handleAddBlock } from '../../../../server/bff';

/**
 * `POST /api/account/blocks` — the browser's only entry to blocking somebody (0103).
 *
 * The body names a conversation or a seller slug. There is no shape it could use to name an account, which
 * is a property of the shared contract rather than of this file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleAddBlock(request);
}
