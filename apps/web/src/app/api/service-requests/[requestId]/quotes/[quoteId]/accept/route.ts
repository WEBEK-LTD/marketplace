import { handleAcceptServiceQuote } from '../../../../../../../server/bff';

/**
 * `POST /api/service-requests/:requestId/quotes/:quoteId/accept` (Phase 7-I).
 *
 * A quote is addressed **through its own brief**: both identifiers travel in the path, both are checked for
 * shape by the shared handler, and the API refuses a quote that belongs to a different brief — so a quote
 * identifier cannot be spent from the wrong page. Which side may take this step is the database's decision.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string; quoteId: string }> },
): Promise<Response> {
  const { requestId, quoteId } = await context.params;
  return handleAcceptServiceQuote(request, requestId, quoteId);
}
