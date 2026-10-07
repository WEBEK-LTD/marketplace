import { handleCmsPageCover } from '../../../../../../admin/server/bff';

/**
 * `PUT /admin/api/cms/pages/cover` — attach or remove a page's cover image (0099).
 *
 * Separate from the page's own route for the same reason the status is: a change to a page's address must not
 * be able to change what it looks like, and the reverse.
 *
 * The body names a library entry by id and nothing more. There is no upload here, no listing of the library,
 * and no URL: the `cms-media` bucket is private, so what the console shows for an attached cover is the stored
 * object path and the alt text somebody wrote. Whether the id names an entry is decided by the database's own
 * foreign key.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCmsPageCover(request);
}
