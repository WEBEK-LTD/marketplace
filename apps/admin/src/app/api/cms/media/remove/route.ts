import { handleCmsMediaRemove } from '../../../../../server/bff';

/**
 * `POST /api/cms/media/remove` — remove one library entry.
 *
 * Every reference to it becomes null through migration 0030's own `on delete set null` foreign keys and through
 * nothing else. The screen shows those references before it offers this. The stored object stays in the private
 * bucket and becomes unreachable, because a signed read is only issued for an object an entry still points at.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCmsMediaRemove(request);
}
