import { handleCmsPageTranslationSave } from '../../../../../server/bff';

/**
 * `PUT /api/cms/pages/translations` — write one locale of a page.
 *
 * Creating and replacing are the same request, which is what the upstream writer does. The lengths and the
 * requirement that a title and a body are present are the contract's and then the database's; this route
 * carries the request.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCmsPageTranslationSave(request);
}
