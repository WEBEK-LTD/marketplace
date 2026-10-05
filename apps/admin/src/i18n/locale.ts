import type { Locale, TextDirection } from '@repo/shared-types';

export const ADMIN_LOCALES: readonly Locale[] = ['en', 'ar'];

/**
 * The console's language, from the reader's own profile (v5.2; no `/ar` prefix in admin).
 *
 * Phase 1 left this returning English because profiles arrived with authentication, which had not been
 * built. 7-F is the increment where the console has both an authenticated session and a profile read,
 * so it now resolves what v5.2 always said it should: the person's own `locale_code`.
 *
 * **It never fails a page.** A signed-out visitor, an unreachable API and a profile with no language set
 * all resolve to English. The language a console is rendered in is not an authorization decision, and a
 * sign-in screen that would not render because a database was busy would be worse than an English one.
 *
 * The session read is shared with the page gate through React's `cache`, so resolving the language
 * costs nothing beyond the call the page was going to make anyway.
 */
export async function resolveAdminLocale(): Promise<Locale> {
  try {
    const { currentStaffSession } = await import('../server/current-staff');
    const result = await currentStaffSession();
    if (result.kind !== 'ok') return 'en';
    return result.session.localeCode === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en';
  }
}

export function directionFor(locale: Locale): TextDirection {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
