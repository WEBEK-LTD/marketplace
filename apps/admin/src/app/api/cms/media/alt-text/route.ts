import { handleCmsMediaAltText } from '../../../../../server/bff';

/**
 * `PUT /api/cms/media/alt-text` — replace one entry's English and Arabic alt text.
 *
 * The only editable thing about a stored object: the path, the type, the size and the dimensions describe a file that
 * has already been uploaded. Neither alt text is required, and a blank one is stored as absent.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCmsMediaAltText(request);
}
