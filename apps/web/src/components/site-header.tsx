import type { Locale } from '@repo/shared-types';
import { PageContainer } from '@repo/ui';
import type { ReactNode } from 'react';

export interface SiteHeaderProps {
  readonly locale: Locale;
  readonly siteName: string;
  readonly languageLink: string;
  readonly languageLinkLabel: string;
  /**
   * The composed navigation, where this surface carries any (0094).
   *
   * Absent on the account and authentication surfaces (owner decision 2), and absent when no menu has been composed
   * or the menus could not be read — in which case this is exactly the header it has always been (owner decision 7).
   */
  readonly navigation?: ReactNode;
  /** The same menu again, for the width where a row of entries does not fit. */
  readonly mobileNavigation?: ReactNode;
}

/**
 * The site header.
 *
 * **The locale switch is part of the application, not of the navigation** (owner decision 8). It is an affordance
 * every page needs regardless of what anybody composed, so it stays here as code and is not an entry an operator
 * could delete.
 */
export function SiteHeader({
  locale,
  siteName,
  languageLink,
  languageLinkLabel,
  navigation,
  mobileNavigation,
}: SiteHeaderProps) {
  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <header className="border-b border-neutral-200">
      <PageContainer>
        <div className="flex items-center justify-between gap-4 py-4">
          <span className="text-lg font-semibold">{siteName}</span>
          {/* On wider screens the entries sit in the header itself; the drawer below takes over when they do not fit. */}
          {navigation === undefined ? null : <div className="hidden sm:block">{navigation}</div>}
          <a href={otherLocale === 'ar' ? '/ar' : '/'} hrefLang={otherLocale} lang={otherLocale} aria-label={languageLinkLabel} className="text-sm underline">
            {languageLink}
          </a>
        </div>
        {mobileNavigation === undefined ? null : <div className="pb-4 sm:hidden">{mobileNavigation}</div>}
      </PageContainer>
    </header>
  );
}
