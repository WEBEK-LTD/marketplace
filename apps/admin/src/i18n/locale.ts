import type { Locale, TextDirection } from '@repo/shared-types';

export const ADMIN_LOCALES: readonly Locale[] = ['en', 'ar'];

/**
 * Admin language comes from the user's profile (v5.2; no /ar prefix in admin).
 * User profiles arrive with authentication in Phase 3, so English is used until then.
 */
export async function resolveAdminLocale(): Promise<Locale> {
  return 'en';
}

export function directionFor(locale: Locale): TextDirection {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
