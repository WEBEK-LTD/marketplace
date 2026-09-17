import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorView } from '../src/components/error-view';
import { SiteFooter } from '../src/components/site-footer';
import { SiteHeader } from '../src/components/site-header';

describe('web components', () => {
  it('the error view shows only the translated title and retry button', () => {
    const html = renderToStaticMarkup(<ErrorView title="حدث خطأ ما" retryLabel="حاول مرة أخرى" onRetry={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('>حدث خطأ ما</h1>');
    expect(html).toContain('>حاول مرة أخرى</button>');
    expect(html).not.toMatch(/stack|digest/i);
  });

  it('the header links to the other language only', () => {
    const en = renderToStaticMarkup(<SiteHeader locale="en" siteName="Marketplace" languageLink="العربية" languageLinkLabel="Switch to Arabic" />);
    expect(en).toContain('href="/ar"');
    expect(en.match(/<a /g)).toHaveLength(1);
    const ar = renderToStaticMarkup(<SiteHeader locale="ar" siteName="السوق" languageLink="English" languageLinkLabel="التبديل إلى الإنجليزية" />);
    expect(ar).toContain('href="/"');
    expect(ar).toContain('hrefLang="en"');
  });

  it('the footer shows the given copyright line', () => {
    expect(renderToStaticMarkup(<SiteFooter copyright="© 2026 السوق" />)).toContain('>© 2026 السوق</p>');
  });
});
