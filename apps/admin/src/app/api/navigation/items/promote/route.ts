import { handleNavigationItemPromote } from '../../../../../server/bff';

/**
 * `POST /api/navigation/items/promote` — move one entry out from under its heading.
 *
 * Its own route because an absent parent on a change has to keep meaning "leave it where it is", so clearing one
 * needs a way to be said.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationItemPromote(request);
}
