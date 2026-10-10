import type { Locale } from '@repo/shared-types';
import { PageContainer, SkipLink } from '@repo/ui';
import type { ReactNode } from 'react';
import { directionFor } from '../i18n/locale';
import { ADMIN_FOOTER, ADMIN_HEADER, ADMIN_WORDMARK, ADMIN_WORDMARK_SECTION } from '../ui';

export interface AdminLabels {
  readonly siteName: string;
  readonly section: string;
  readonly skipToContent: string;
  readonly copyright: string;
}

/**
 * The admin page frame. Takes the locale explicitly so Arabic/RTL can be tested directly.
 *
 * **The masthead is inverted, and that is the console's whole identity.** Since 0108 the console and the
 * marketplace share one origin and one deployment, which is convenient and makes them easy to confuse: a
 * member of staff with both open has two tabs that looked, until now, like the same grey document. A dark
 * bar across the top settles it at a glance, costs nothing — `surface.ink` is the brand at its own
 * lightness — and needs no word of explanation.
 *
 * The body names `surface-canvas` and `ink-strong` explicitly, because this document has its own `<html>`
 * and cannot rely on the public layout having set anything. **Strong, not body**, which is the same pairing
 * `BAND.canvas` establishes on the public side: a surface sets the strong role and text that is secondary
 * opts into `ink-muted` or `ink-body` where it is written. Setting the body role here instead made every
 * unstyled heading in the console grey — which is exactly what the first screenshot after this change
 * showed, and why it is now stated rather than left to inherit.
 */
export function AdminDocument({ locale, labels, children }: { locale: Locale; labels: AdminLabels; children: ReactNode }) {
  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body className="flex min-h-screen flex-col bg-surface-canvas text-ink-strong">
        <SkipLink targetId="content">{labels.skipToContent}</SkipLink>
        <header className={ADMIN_HEADER}>
          <PageContainer>
            <p className={`py-4 ${ADMIN_WORDMARK}`}>
              {labels.siteName} <span className={ADMIN_WORDMARK_SECTION}>{labels.section}</span>
            </p>
          </PageContainer>
        </header>
        <main id="content" className="flex-1">
          {children}
        </main>
        <footer className={ADMIN_FOOTER}>
          <PageContainer>
            <p className="py-6 text-sm text-ink-muted">{labels.copyright}</p>
          </PageContainer>
        </footer>
      </body>
    </html>
  );
}
