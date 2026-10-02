import { handleCmsPageTranslationRemove } from '../../../../../../server/bff';

/**
 * `POST /api/cms/pages/translations/remove` — remove one locale of a page.
 *
 * A `POST` carrying what to remove, because the same-origin check this origin applies reads a submitted body
 * and the form that drives this submits one. The upstream call is the API's `DELETE`.
 *
 * Removing the last locale of a live page is refused upstream — the mirror of the rule that a page cannot be
 * published before it is written — and that refusal is forwarded so the screen can say which it was.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCmsPageTranslationRemove(request);
}
