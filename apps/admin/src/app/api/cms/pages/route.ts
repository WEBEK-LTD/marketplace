import { handleCmsPageCreate, handleCmsPageUpdate } from '../../../../server/bff';

/**
 * `POST /api/cms/pages` creates a draft; `PATCH /api/cms/pages` changes a page's address or presentation.
 *
 * Both bodies are rebuilt field by field by the shared handlers from the contract's own fields, so anything
 * else a browser sends is dropped before it leaves this origin. **Neither can change a page's status**: that
 * lives at `/api/cms/pages/status`, so a rename cannot publish a half-written page.
 *
 * There is no `DELETE`: the API has no route that removes a page, because a published address that simply
 * vanished would leave every link to it broken. A page is archived instead, which is a lifecycle change.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCmsPageCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleCmsPageUpdate(request);
}
