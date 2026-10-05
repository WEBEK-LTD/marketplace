import { handleSellerVerificationDocument } from '../../../../../../server/bff';

/**
 * `POST /api/sellers/me/verification/documents` — record one uploaded document (Phase 6-I).
 *
 * There is no GET here: the documents come back with the attempt itself, and a second listing route would be
 * a second projection to keep free of object paths.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSellerVerificationDocument(request);
}
