import { handleLogout } from '../../../../server/bff';

/**
 * `POST /api/auth/logout` — the browser's only way to end its session.
 *
 * It ends this session and no other: nothing here, and nothing it calls, revokes an account's other
 * sessions.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleLogout(request);
}
