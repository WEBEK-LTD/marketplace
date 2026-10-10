import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorView } from '../src/components/error-view';
import { SiteFooter } from '../src/components/site-footer';
import { SiteHeader } from '../src/components/site-header';
import { SiteSearchForm } from '../src/components/site-search-form';

/** The chrome's copy, supplied by the layout from the namespaces that already own each string. */
const LABELS = {
  menu: 'Menu',
  closeMenu: 'Close menu',
  listings: 'Browse listings',
  services: 'Find a service',
  categories: 'All categories',
};

const FOOTER_LABELS = { listings: 'Browse listings', services: 'Find a service', categories: 'All categories' };

describe('web components', () => {
  it('the error view shows only the translated title and retry button', () => {
    const html = renderToStaticMarkup(<ErrorView title="حدث خطأ ما" retryLabel="حاول مرة أخرى" onRetry={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('حدث خطأ ما');
    expect(html).toContain('حاول مرة أخرى');
    expect(html).not.toMatch(/stack|digest/i);
  });
});

describe('the site header', () => {
  const render = (locale: 'en' | 'ar', publicSurface = true) =>
    renderToStaticMarkup(
      <SiteHeader
        locale={locale}
        siteName={locale === 'ar' ? 'السوق' : 'Marketplace'}
        languageLink={locale === 'ar' ? 'English' : 'العربية'}
        languageLinkLabel={locale === 'ar' ? 'التبديل إلى الإنجليزية' : 'Switch to Arabic'}
        labels={LABELS}
        publicSurface={publicSurface}
      />,
    );

  it('links to the other language, announced in the language it offers', () => {
    const en = render('en');
    expect(en).toContain('href="/ar"');
    expect(en).toContain('hrefLang="ar"');
    // `lang` as well as `hrefLang`: without it a screen reader reads "العربية" with an English voice.
    expect(en).toContain('lang="ar"');

    const ar = render('ar');
    expect(ar).toContain('href="/"');
    expect(ar).toContain('hrefLang="en"');
  });

  it('is sticky, translucent, and separated from the content that scrolls under it', () => {
    // It genuinely floats above a long scrolling grid. 0110 carries that with a backdrop blur and a hairline
    // rather than with a shadow: content disappearing under a solid bar reads as content lost, where content
    // passing behind a translucent one reads as depth. The hairline is what keeps the two surfaces distinct.
    const html = render('en');
    expect(html).toContain('sticky top-0');
    expect(html).toContain('backdrop-blur');
    expect(html).toContain('border-b border-hairline');
    expect(html).toMatch(/bg-surface-canvas\/\d/);
  });

  it('carries no search field, and so no form, on any surface', () => {
    // 0109 built a persistent header search and then removed it: nothing in the specification authorises one, the
    // marketplace hub is documented as having no search box, and the read-only seller surfaces are asserted to
    // render no form at all — which a search form is. Search lives on the home page and on `/search`.
    for (const html of [render('en'), render('ar'), render('en', false)]) {
      expect(html).not.toContain('<form');
      expect(html).not.toContain('name="q"');
    }
  });

  it('offers the catalogue in the drawer even when no menu was composed', () => {
    // Products, services and categories are routes that exist in code, so a visitor on a phone can always reach
    // the catalogue — the reasoning owner decision 8 applies to the locale switch.
    const html = render('en');
    for (const href of ['/listings', '/services', '/categories']) expect(html).toContain(`href="${href}"`);
    const ar = render('ar');
    for (const href of ['/ar/listings', '/ar/services', '/ar/categories']) expect(ar).toContain(`href="${href}"`);
  });

  it('keeps the plain chrome on the account and authentication surfaces', () => {
    // Owner decision 2 (0094). Those surfaces get the brand and the locale switch owner decision 8 makes part of
    // the application, and nothing else — no catalogue doors and no drawer to hold them.
    const html = render('en', false);
    expect(html).toContain('href="/"');
    expect(html).toContain('hrefLang="ar"');
    for (const href of ['/listings', '/services', '/categories']) expect(html).not.toContain(`href="${href}"`);
    expect(html).not.toContain(LABELS.menu);
  });

  it('uses no physical direction utilities, so the row mirrors in Arabic', () => {
    const html = render('ar');
    expect(html).not.toMatch(/\b(?:pl|pr|ml|mr)-\d/);
    expect(html).not.toMatch(/\b(?:left|right)-\d/);
  });
});

describe('the site footer', () => {
  const html = renderToStaticMarkup(
    <SiteFooter copyright="© 2026 السوق" siteName="السوق" locale="ar" labels={FOOTER_LABELS} publicSurface />,
  );

  it('shows the given copyright line last', () => {
    expect(html).toContain('© 2026 السوق');
  });

  it('ends the page somewhere useful, in the reader’s language', () => {
    for (const href of ['/ar/listings', '/ar/services', '/ar/categories']) expect(html).toContain(`href="${href}"`);
  });
});

describe('the marketplace search form', () => {
  const html = renderToStaticMarkup(
    <SiteSearchForm action="/search" placeholder="Search the marketplace" submitLabel="Search" />,
  );

  it('is a GET form, so a search is a URL', () => {
    // Shareable, bookmarkable, reachable with the back button, and working with no JavaScript.
    expect(html).toContain('method="get"');
    expect(html).toContain('role="search"');
    expect(html).toContain('name="q"');
  });

  it('enforces the contract’s own minimum before a request is made', () => {
    // `SEARCH_MIN_QUERY_LENGTH` is 2; the page refuses a shorter query server-side as well.
    expect(html).toContain('minLength="2"');
  });

  it('lets the browser decide the query’s direction', () => {
    // A query may be in either script whatever language the page is in.
    expect(html).toContain('dir="auto"');
  });
});
