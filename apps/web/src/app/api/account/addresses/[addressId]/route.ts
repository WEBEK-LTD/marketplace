import { handleDeleteAddress, handleUpdateAddress } from '../../../../../server/bff';

/** `PATCH` and `DELETE /api/account/addresses/:addressId` (Phase 7-E). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ addressId: string }> },
): Promise<Response> {
  const { addressId } = await context.params;
  return handleUpdateAddress(request, addressId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ addressId: string }> },
): Promise<Response> {
  const { addressId } = await context.params;
  return handleDeleteAddress(request, addressId);
}
