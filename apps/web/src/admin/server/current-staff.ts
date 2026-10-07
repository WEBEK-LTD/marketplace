import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { readStaffSession, type StaffSessionResult } from './bff';

/**
 * The console session for the request being rendered (Phase 7-F).
 *
 * Wrapped in React's `cache` so the several places that need it within one render — the language
 * resolution, the page gate, the header, the navigation — share **one** answer from **one** call. That
 * is not only a saving: two independent reads could in principle disagree, and a console whose gate and
 * whose navigation had different ideas of what somebody may do would be a console with a bug in the
 * only place a bug really matters.
 *
 * It reads the request's own `Cookie` header and nothing else. No page passes it an account, a
 * permission or an assurance level, because there is no parameter here for one.
 */
export const currentStaffSession = cache(async (): Promise<StaffSessionResult> => {
  const requestHeaders = await headers();
  return await readStaffSession({ cookieHeader: requestHeaders.get('cookie') });
});

/**
 * The request's own `Cookie` header (Phase 7-G).
 *
 * A gated page's children need it to make their own reads, and this is the one place it is read, so a
 * component cannot accidentally construct a session from anything else. It is never forwarded upstream:
 * the BFF takes the access token out of it and presents that alone.
 */
export const currentCookieHeader = cache(async (): Promise<string | null> => {
  const requestHeaders = await headers();
  return requestHeaders.get('cookie');
});
