import { handleFaqCreate, handleFaqUpdate } from '../../../server/bff';

/**
 * `POST /api/faqs` — create an unpublished entry.
 * `PATCH /api/faqs` — change a topic, a wording or a position.
 *
 * Both on the collection, with the entry's identifier in the body rather than the path, because the same-origin
 * check reads a submitted body and the browser forms that drive these submit one.
 *
 * **Neither handler forwards a publication flag.** Publishing is `/api/faqs/state`, so editing an answer can never
 * put it on a public page however the body is shaped.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFaqCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleFaqUpdate(request);
}
