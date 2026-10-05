import { handleNavigationItemRemove } from '../../../../../server/bff';

/** `POST /api/navigation/items/remove` — remove one entry, and anything under it. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationItemRemove(request);
}
