import type { Locale, TextDirection } from '@repo/shared-types';
import { defineRouting } from 'next-intl/routing';

/** English at the root, Arabic under /ar. The URL alone decides the language. */
export const routing = defineRouting({
  locales: ['en', 'ar'] satisfies Locale[],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeDetection: false,
  localeCookie: false,
});

export function directionFor(locale: Locale): TextDirection {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
