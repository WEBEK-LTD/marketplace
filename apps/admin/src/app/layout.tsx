import './globals.css';
import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AdminDocument } from '../components/admin-document';

// Per-request rendering is required for the CSP nonce (owner decision: nonce CSP everywhere).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Site');
  return { title: `${t('name')} ${t('section')}`, robots: { index: false, follow: false } };
}

export default async function AdminRootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const messages = await getMessages();
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
