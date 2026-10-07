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
import { SITE_CHROME_HEADER, SURFACE_ADMIN, SURFACE_HEADER } from '../proxy-headers';
import { AdminDocument } from '../admin/components/admin-document';

// Per-request rendering is required for the CSP nonce (owner decision: nonce CSP everywhere).
export const dynamic = 'force-dynamic';

/**
 * Whether this request is being answered by the staff console (0108).
 *
 * One Next.js app serves both surfaces, so there is exactly one root layout and exactly one `generateMetadata`, and
 * each has to answer for both. They ask the proxy rather than the pathname, because a root layout cannot see the
 * pathname and the proxy is the one place that can. The proxy drops any inbound copy of the header first, so a
 * client cannot claim this surface for itself.
 */
async function isAdminSurface(): Promise<boolean> {
  return (await headers()).get(SURFACE_HEADER) === SURFACE_ADMIN;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Site');
  // The console's title carries its section and is `noindex` for the same reason every console response is.
  if (await isAdminSurface()) {
    return { title: `${t('name')} ${t('section')}`, robots: { index: false, follow: false } };
  }
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
  const requestHeaders = await headers();

  // ------------------------------------------------------------------------------------------------
  // The staff console (0108). Its own document, from its own component tree, in its own language.
  // ------------------------------------------------------------------------------------------------
  // This is the whole of the UI isolation between the two surfaces, and it is isolation by construction
  // rather than by convention: the two branches share no element, no chrome component and no message
  // catalogue. `getLocale` and `getMessages` already answer for the console here, because the next-intl
  // request config branches on the same header — so the console's language is the reader's own profile
  // setting and the marketplace's is still the URL, exactly as each always was.
  //
  // Returned before the navigation read below, so a console page never asks the API for marketplace menus.
  if (requestHeaders.get(SURFACE_HEADER) === SURFACE_ADMIN) {
    return (
      <AdminDocument
        locale={locale}
        labels={{
          siteName: t('Site.name'),
          section: t('Site.section'),
          skipToContent: t('Accessibility.skipToContent'),
          copyright: t('Footer.copyright', { year: new Date().getFullYear(), name: t('Site.name') }),
        }}
      >
        <NextIntlClientProvider locale={locale} messages={{ Error: messages.Error }}>
          {children}
        </NextIntlClientProvider>
      </AdminDocument>
    );
  }

  const language: PublicLocale = locale === 'ar' ? 'ar' : 'en';
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
