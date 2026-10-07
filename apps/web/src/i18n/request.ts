import type { Locale } from '@repo/shared-types';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';
import { routing } from './routing';
import { resolveAdminLocale } from '../admin/i18n/locale';
import { SURFACE_ADMIN, SURFACE_HEADER } from '../proxy-headers';

/**
 * The request's language and messages, for whichever surface is answering (0108).
 *
 * One Next.js app serves the public marketplace at `/` and the staff console at `/admin`, and next-intl takes one
 * request config per app — so this is the single place that has to hold both locale models, and it does so by
 * branching rather than by reconciling them:
 *
 *   * **The marketplace reads the URL.** English at the root, Arabic under `/ar`, `localeCookie: false`,
 *     `localeDetection: false`. The URL alone decides, which is what makes a catalogue page cacheable and
 *     shareable in the language it was written in.
 *   * **The console reads the person.** `resolveAdminLocale()` returns the reader's own `locale_code`, because the
 *     console has no locale prefix in its URLs (v5.2) and an administrator's language is a property of the
 *     administrator, not of the address they typed.
 *
 * **The two message catalogues never merge.** They collide on thirteen top-level namespaces with incompatible
 * contents — `Login` is a buyer signing in on one surface and a staff member on the other, `Blog` is a reader's view
 * and an editor's — so merging them would mean one surface silently reading the other's copy. They stay two files
 * and are chosen here.
 *
 * The surface comes from the header the proxy sets, not from a pathname: this config has no access to one. The read
 * is guarded because a language is never worth failing a page over — the same rule `resolveAdminLocale` already
 * follows — and an unreadable header resolves to the public surface, which is the safer of the two to be wrong
 * about: a console page rendered with marketplace copy is visibly broken, while the reverse would put console
 * strings on a public page.
 */
async function isAdminSurface(): Promise<boolean> {
  try {
    return (await headers()).get(SURFACE_HEADER) === SURFACE_ADMIN;
  } catch {
    return false;
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  if (await isAdminSurface()) {
    const locale = await resolveAdminLocale();
    const messages = (await import(`../../messages/admin/${locale}.json`)).default as Record<string, unknown>;
    return { locale, messages };
  }

  const requested = await requestLocale;
  const locale: Locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)).default as Record<string, unknown>;
  return { locale, messages };
});
