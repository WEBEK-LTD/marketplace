import { handleSupportAttachmentLink } from '../../../../server/bff';

/**
 * `GET /api/support/attachment?ticketId=…&attachmentId=…` (Phase 7-L).
 *
 * One short-lived authorization to look at one file. A link cannot be rendered into a page — it expires in
 * minutes — so it is fetched when a colleague asks for it, and no path or bucket is accepted from the client.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSupportAttachmentLink(request);
}
