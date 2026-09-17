// Compile-time checks, run by `pnpm run typecheck`.
import type { Locale, TextDirection } from '../src/index.js';

export const english: Locale = 'en';
export const arabic: Locale = 'ar';
// @ts-expect-error only 'en' and 'ar' are supported locales
export const french: Locale = 'fr';

export const leftToRight: TextDirection = 'ltr';
export const rightToLeft: TextDirection = 'rtl';
// @ts-expect-error only 'ltr' and 'rtl' are directions
export const automatic: TextDirection = 'auto';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const localeIsExact: Exact<Locale, 'en' | 'ar'> = true;
export const directionIsExact: Exact<TextDirection, 'ltr' | 'rtl'> = true;
