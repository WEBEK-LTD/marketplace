import { handleTagCreate, handleTagUpdate } from '../../../../admin/server/bff';

/**
 * `POST /admin/api/tags` creates one tag; `PATCH /admin/api/tags` renames one.
 *
 * **Neither can change a slug.** It is the tag's public identity and there is no tag slug history to redirect from.
 * A tag is created active, unlike an attribute definition: there is nothing to fill in first.
 *
 * There is no `DELETE`: `listing_tags` references a tag with `ON DELETE RESTRICT`, so a tag is hidden instead.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleTagCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleTagUpdate(request);
}
