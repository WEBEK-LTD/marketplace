import { handleFaqsReorder } from '../../../../../admin/server/bff';

/** `POST /api/faqs/reorder` — set the order of one topic, whole, so no half-applied arrangement is reachable. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFaqsReorder(request);
}
