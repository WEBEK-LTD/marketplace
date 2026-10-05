import { handleDisputeResolution } from '../../../../server/bff';

/**
 * `POST /api/disputes/resolution` (Phase 7-R).
 *
 * The body is rebuilt field by field by the shared handler from the contract’s three fields; a resolver, a
 * timestamp, a status, an order status or anything naming a refund or a payment sent alongside them is dropped
 * before anything leaves this origin.
 *
 * **This records a decision and moves no money.** A refund resolution records that a refund is owed; no
 * refund, payment reversal, ledger entry, balance change, payout or provider call happens here or anywhere
 * downstream of it. Issuing the refund is a separate, later operation, and there is deliberately no route for
 * one on this origin.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDisputeResolution(request);
}
