import { handleBlogIndex } from '../../../server/bff';

/**
 * `GET /api/blog` — one page of the blog index, for a browser that wants another.
 *
 * The browser never reaches the API and never learns its address or its credential; this origin makes the one
 * internal hop. No session is read, because a post is the same for everyone.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleBlogIndex(request);
}
