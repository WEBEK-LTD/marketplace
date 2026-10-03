import { handleSeoSettingsRemove } from '../../../../../server/bff';

/**
 * `POST /api/seo/settings/remove` — remove one locale's site-wide SEO defaults.
 *
 * Afterwards the locale is unauthored. For the default locale that returns `/robots.txt` to the minimal document the
 * public web already serves when nothing has been authored, which is the state the platform ships in. The audit trail
 * keeps the removed row.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSeoSettingsRemove(request);
}
