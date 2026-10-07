import { handleHomepageSectionCreate, handleHomepageSectionUpdate } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/homepage/sections` — create a hidden section.
 * `PATCH /admin/api/homepage/sections` — change one's key, type, text, configuration or position.
 *
 * Both on the collection, with the section's identifier in the body rather than the path, because the same-origin
 * check reads a submitted body and the browser forms that drive these submit one.
 *
 * **Neither handler forwards a visibility flag.** Showing a section is `/admin/api/homepage/sections/state`, so editing
 * one can never put it in front of the public however the body is shaped.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleHomepageSectionCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleHomepageSectionUpdate(request);
}
