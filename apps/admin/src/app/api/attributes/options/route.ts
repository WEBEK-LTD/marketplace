import { handleAttributeOptionCreate, handleAttributeOptionUpdate } from '../../../../server/bff';

/**
 * `POST /api/attributes/options` adds one option to a select attribute; `PATCH` edits one option's labels and
 * order.
 *
 * **Neither can change an option's value.** The value is what every stored answer refers to, so it is given once
 * and never again; what an administrator edits is what the option is called. Adding an option to a text, number or
 * boolean attribute is refused upstream.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleAttributeOptionCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleAttributeOptionUpdate(request);
}
