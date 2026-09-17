import './globals.css';
import type { Locale } from '@repo/shared-types';
import { SkipLink } from '@repo/ui';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SiteFooter } from '../components/site-footer';
import { SiteHeader } from '../components/site-header';
import { directionFor } from '../i18n/routing';

// Per-request rendering is required for the CSP nonce (owner decision: nonce CSP everywhere).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Site');
  return { title: t('name'), robots: { index: false, follow: false } };
}

/**
 * Root layout. The locale comes from next-intl's proxy (the URL decides it), which lets unknown
 * URLs render the localized root not-found page as real server HTML (see app/not-found.tsx).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body className="flex min-h-screen flex-col">
        <NextIntlClientProvider locale={locale} messages={{ Error: messages.Error }}>
          <SkipLink targetId="content">{t('Accessibility.skipToContent')}</SkipLink>
          <SiteHeader
            locale={locale}
            siteName={t('Site.name')}
            languageLink={t('Header.languageLink')}
            languageLinkLabel={t('Header.languageLinkLabel')}
          />
          <main id="content" className="flex-1">
            {children}
          </main>
          <SiteFooter copyright={t('Footer.copyright', { year: new Date().getFullYear(), name: t('Site.name') })} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
