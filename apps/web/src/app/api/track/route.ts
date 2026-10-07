import { handleTrack } from '../../../server/bff';

/**
 * `POST /api/track` — the analytics beacon (0101).
 *
 * The only write route on this origin that does not require a session: a signed-out visitor browsing the
 * catalogue is the normal case. The same-origin check still applies, the body is still validated against the
 * contract, and the hop upstream still carries the internal credential.
 *
 * The analytics session is this server's own cookie, resolved and issued by the handler. A page cannot name a
 * session, an account or a digest: the contract has no field for any of them.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleTrack(request);
}
