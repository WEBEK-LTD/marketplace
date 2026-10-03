import './globals.css';
import type { Locale } from '@repo/shared-types';
import { SkipLink } from '@repo/ui';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { headers } from 'next/headers';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { PublicLocale } from '@repo/config';
import { SiteFooter } from '../components/site-footer';
import { SiteHeader } from '../components/site-header';
import { FooterMenu, HeaderMenu, MobileMenu, resolveMenus } from '../components/site-navigation';
import { directionFor } from '../i18n/routing';
import { readSiteNavigation } from '../server/bff';
import { SITE_CHROME_HEADER } from '../proxy-headers';

// Per-request rendering is required for the CSP nonce (owner decision: nonce CSP everywhere).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Site');
  return { title: t('name'), robots: { index: false, follow: false } };
}

/**
 * Root layout. The locale comes from next-intl's proxy (the URL decides it), which lets unknown
 * URLs render the localized root not-found page as real server HTML (see app/not-found.tsx).
 *
 * **The composed navigation is rendered here, and only on public surfaces** (0094, owner decision 2). Which surface
 * this is comes from the header the proxy sets, because the proxy is where the path is known and where the account
 * area is already defined. An absent header means the plain chrome: the instruction is "public surfaces only", so
 * the failure that keeps a composed header off an account page is the one to prefer.
 *
 * **Nothing here can break a page** (owner decision 7). The read returns null rather than throwing, and a site with
 * no menus composed renders exactly the header and footer this application has always had.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const messages = await getMessages();

  const language: PublicLocale = locale === 'ar' ? 'ar' : 'en';
  const requestHeaders = await headers();
  const isPublicSurface = requestHeaders.get(SITE_CHROME_HEADER) === 'navigation';
  // One read for the whole chrome, and only where the chrome carries navigation at all.
  const menus = isPublicSurface ? resolveMenus(language, (await readSiteNavigation(language)) ?? []) : [];
  const menuFor = (key: string) => menus.find((menu) => menu.menuKey === key);
  const header = menuFor('header');
  const mobile = menuFor('mobile') ?? header;
  const footer = menuFor('footer');

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
            {...(header === undefined ? {} : { navigation: <HeaderMenu menu={header} /> })}
            {...(mobile === undefined ? {} : { mobileNavigation: <MobileMenu menu={mobile} /> })}
          />
          <main id="content" className="flex-1">
            {children}
          </main>
          <SiteFooter
            copyright={t('Footer.copyright', { year: new Date().getFullYear(), name: t('Site.name') })}
            {...(footer === undefined ? {} : { navigation: <FooterMenu menu={footer} /> })}
          />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
