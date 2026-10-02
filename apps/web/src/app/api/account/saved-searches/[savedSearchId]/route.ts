import { handleDeleteSavedSearch, handleUpdateSavedSearch } from '../../../../../server/bff';

/** `PATCH` and `DELETE /api/account/saved-searches/:savedSearchId` (Phase 7-E). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ savedSearchId: string }> },
): Promise<Response> {
  const { savedSearchId } = await context.params;
  return handleUpdateSavedSearch(request, savedSearchId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ savedSearchId: string }> },
): Promise<Response> {
  const { savedSearchId } = await context.params;
  return handleDeleteSavedSearch(request, savedSearchId);
}
