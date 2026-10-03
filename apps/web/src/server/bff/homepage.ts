import 'server-only';
import {
  PublicHomepageResponseSchema,
  publicLocaleOf,
  type PublicHomepageSection,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public homepage (0093).
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module makes the one
 * internal hop with the BFF credential attached. It carries no session, because the homepage is the same for
 * everyone.
 *
 * The answer is **validated** rather than forwarded, with the shared contract — so the page and the API cannot
 * drift apart silently, and a section carrying a field nobody declared cannot reach a browser.
 *
 * **Null means the homepage could not be read; an empty array means nobody has composed one.** The two are
 * different answers and the page renders differently for each: a fresh marketplace has a homepage, and an outage is
 * said out loud rather than shown as a bare page.
 */

export interface HomepageFetchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** The homepage's sections, or null when it could not be read at all. */
export async function readHomepage(
  locale: string,
  options: HomepageFetchOptions = {},
): Promise<readonly PublicHomepageSection[] | null> {
  const query = new URLSearchParams({ locale: publicLocaleOf(locale) });
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/homepage?${query.toString()}`, { method: 'GET' });
  } catch {
    return null;
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return null;
  }

  try {
    const parsed = PublicHomepageResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? parsed.data.sections : null;
  } catch {
    return null;
  }
}
