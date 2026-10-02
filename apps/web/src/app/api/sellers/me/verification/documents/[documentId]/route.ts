import { handleSellerVerificationDocumentRemove } from '../../../../../../../server/bff';

/**
 * `DELETE /api/sellers/me/verification/documents/:documentId` — remove one document (Phase 6-I).
 *
 * The only DELETE on the seller surface, and it removes a document the caller uploaded: never an attempt,
 * which a seller cannot withdraw, and never a storefront or a listing. Whether the document is still
 * removable is the database's to decide, and a refusal is indistinguishable from the document not existing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await context.params;
  return handleSellerVerificationDocumentRemove(request, documentId);
}
