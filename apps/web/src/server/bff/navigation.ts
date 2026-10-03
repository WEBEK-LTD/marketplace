import 'server-only';
import {
  NAVIGATION_MENU_KEYS,
  PublicNavigationResponseSchema,
  publicLocaleOf,
  type NavigationMenuKey,
  type PublicNavigationMenu,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public navigation (0094).
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module makes the one
 * internal hop with the BFF credential attached. It carries no session, because the menus are the same for
 * everyone.
 *
 * **One read for the whole chrome.** The header, the footer and the mobile drawer are asked for together, because
 * every page renders all three and three round trips per request would be three times the cost for one answer.
 *
 * The answer is **validated** rather than forwarded, with the shared contract — so the pages and the API cannot
 * drift apart silently, and a menu carrying a field nobody declared cannot reach a browser.
 *
 * **Null means the navigation could not be read; an empty array means nobody has composed any.** The two are
 * different answers, and owner decision 7 is why: both fall back to the application's own plain chrome, and
 * neither may break the page — so a failure here is a value and never an exception.
 */

export interface NavigationFetchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** Which placements to ask for. Defaults to all three. */
  readonly menuKeys?: readonly NavigationMenuKey[];
}

/** The composed menus, or null when they could not be read at all. */
export async function readSiteNavigation(
  locale: string,
  options: NavigationFetchOptions = {},
): Promise<readonly PublicNavigationMenu[] | null> {
  const query = new URLSearchParams({
    locale: publicLocaleOf(locale),
    menus: (options.menuKeys ?? NAVIGATION_MENU_KEYS).join(','),
  });

  let config: ReturnType<typeof readBffConfig>;
  try {
    config = readBffConfig(options.env);
  } catch {
    // The chrome of every page on the site goes through here, so even a misconfigured environment degrades to the
    // plain header and footer rather than failing the page (owner decision 7).
    return null;
  }

  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/navigation?${query.toString()}`, { method: 'GET' });
  } catch {
    return null;
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return null;
  }

  try {
    const parsed = PublicNavigationResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? parsed.data.menus : null;
  } catch {
    return null;
  }
}
