import { handleSellerStatusChange } from '../../../../server/bff';

/**
 * `POST /api/sellers/status` (Phase 7-O).
 *
 * The body is rebuilt field by field by the shared handler from the contract’s two fields; a timestamp, a
 * verification value or anything naming another domain sent alongside them is dropped before anything leaves
 * this origin. Which transitions are legal is decided in the database, not here.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSellerStatusChange(request);
}
