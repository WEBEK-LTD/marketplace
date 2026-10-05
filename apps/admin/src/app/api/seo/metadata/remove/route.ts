import { handleSeoMetadataRemove } from '../../../../../server/bff';

/**
 * `POST /api/seo/metadata/remove` — remove one override.
 *
 * Removing an override returns that surface to the metadata it derives from its own content, which is why removal is
 * real here where an authored page is archived instead: an override is an instruction about a surface rather than
 * content with an address. The audit trail keeps the removed row.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSeoMetadataRemove(request);
}
