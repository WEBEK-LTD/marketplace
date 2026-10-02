import { handleSeoRedirectRemove } from '../../../../../server/bff';

/**
 * `POST /api/seo/redirects/remove` — remove one entry.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the CMS translations route gives: the
 * same-origin check reads a submitted body, and the browser form that drives this submits one.
 *
 * Removal is real for this row, where an authored page is archived instead. A page is content with a public address
 * and a history; a map entry is an instruction about an address, and an instruction nobody wants any more has no
 * archived form. The audit trail keeps the removed row, and switching the entry off is the reversible alternative
 * the screen offers first.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSeoRedirectRemove(request);
}
