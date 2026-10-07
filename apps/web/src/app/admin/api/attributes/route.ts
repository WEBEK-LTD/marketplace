import { handleAttributeCreate, handleAttributeUpdate } from '../../../../admin/server/bff';

/**
 * `POST /admin/api/attributes` defines one attribute; `PATCH /admin/api/attributes` edits its labels, unit, filterability
 * and order.
 *
 * Both bodies are rebuilt from the shared contract, so anything else a browser sends is dropped before it leaves
 * this origin. **Neither can rename a key, retype an attribute or show one.** The key is the identity every public
 * listing projection carries, the data type is what every stored answer was validated against, and the visible
 * state lives at `/admin/api/attributes/state` so that an edit can never put a field on every seller's form by accident.
 *
 * There is no `DELETE`: the API has no route that removes an attribute, because `category_attributes` and sellers'
 * own answers reference one with `ON DELETE RESTRICT`. An attribute is hidden instead.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleAttributeCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleAttributeUpdate(request);
}
