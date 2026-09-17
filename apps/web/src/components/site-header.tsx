import type { Locale } from '@repo/shared-types';
import { PageContainer } from '@repo/ui';

export interface SiteHeaderProps {
  readonly locale: Locale;
  readonly siteName: string;
  readonly languageLink: string;
  readonly languageLinkLabel: string;
}

export function SiteHeader({ locale, siteName, languageLink, languageLinkLabel }: SiteHeaderProps) {
  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <header className="border-b border-neutral-200">
      <PageContainer>
        <div className="flex items-center justify-between gap-4 py-4">
          <span className="text-lg font-semibold">{siteName}</span>
          <a href={otherLocale === 'ar' ? '/ar' : '/'} hrefLang={otherLocale} lang={otherLocale} aria-label={languageLinkLabel} className="text-sm underline">
            {languageLink}
          </a>
        </div>
      </PageContainer>
    </header>
  );
}
