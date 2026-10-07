import type { Locale } from '@repo/shared-types';
import { PageContainer, SkipLink } from '@repo/ui';
import type { ReactNode } from 'react';
import { directionFor } from '../i18n/locale';

export interface AdminLabels {
  readonly siteName: string;
  readonly section: string;
  readonly skipToContent: string;
  readonly copyright: string;
}

/** The admin page frame. Takes the locale explicitly so Arabic/RTL can be tested directly. */
export function AdminDocument({ locale, labels, children }: { locale: Locale; labels: AdminLabels; children: ReactNode }) {
  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body className="flex min-h-screen flex-col">
        <SkipLink targetId="content">{labels.skipToContent}</SkipLink>
        <header className="border-b border-neutral-200">
          <PageContainer>
            <p className="py-4 text-lg font-semibold">
              {labels.siteName} <span className="text-neutral-600">{labels.section}</span>
            </p>
          </PageContainer>
        </header>
        <main id="content" className="flex-1">
          {children}
        </main>
        <footer className="mt-auto border-t border-neutral-200">
          <PageContainer>
            <p className="py-6 text-sm text-neutral-600">{labels.copyright}</p>
          </PageContainer>
        </footer>
      </body>
    </html>
  );
}
