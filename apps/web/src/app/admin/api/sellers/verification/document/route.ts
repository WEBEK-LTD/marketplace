import { handleVerificationDocumentLink } from '../../../../../../admin/server/bff';

/**
 * `POST /admin/api/sellers/verification/document` — one short-lived look at one document (Phase 7-G).
 *
 * The request carries two identifiers and no path; the object's location is read from the database and
 * never leaves the API. The bucket stays private and no provider credential is ever in the answer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleVerificationDocumentLink(request);
}
