import { handleNavigationItemState } from '../../../../../server/bff';

/** `POST /api/navigation/items/state` — show or hide one entry. Its own route, for the reason the menu's is. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationItemState(request);
}
