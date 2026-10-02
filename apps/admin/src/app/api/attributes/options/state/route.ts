import { handleAttributeOptionState } from '../../../../../server/bff';

/**
 * `PUT /api/attributes/options/state` — show or hide one option.
 *
 * A hidden option can no longer be chosen and no longer appears on a public listing, while the listings that chose
 * it keep it. There is no removal, here or upstream: an option is referenced by every answer that picked it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleAttributeOptionState(request);
}
