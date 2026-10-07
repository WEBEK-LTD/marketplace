import { handleRemoveBlock } from '../../../../../server/bff';

/**
 * `DELETE /api/account/blocks/:reference` — unblock somebody (0103).
 *
 * The route parameter is the opaque reference a list response carried, not an identifier. It is checked
 * here for nothing: the shared handler checks that it is safe to carry in a URL, and the API is the only
 * layer that decodes it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ reference: string }> },
): Promise<Response> {
  const { reference } = await context.params;
  return handleRemoveBlock(request, reference);
}
