import { handleAttributeState } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/attributes/state` — show or hide one attribute.
 *
 * Its own path, because this is the one edit both a seller and a visitor see. Showing a select attribute that has
 * no active option is refused upstream, and the refusal is forwarded so the screen can say which rule turned.
 * Hiding destroys nothing: the answers sellers have already given stay, and come back if it is shown again.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleAttributeState(request);
}
