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
  action: 'List your property',
};

const FOOTER_LABELS = {
  listings: 'Browse listings',
  services: 'Find a service',
  categories: 'All categories',
  browseHeading: 'Browse',
  legalHeading: 'Help and policies',
  terms: 'Terms',
  privacy: 'Privacy',
  cookies: 'Cookies',
  help: 'Help',
  contact: 'Contact',
  tagline: 'Apartments, villas, land and commercial property across Egypt.',
  officeHeading: 'The office',
  telephoneLabel: 'Telephone',
  whatsappLabel: 'WhatsApp',
  emailLabel: 'Email',
  hoursLabel: 'Open',
};

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

  it('carries exactly one action, pointing at a route that exists in code', () => {
    // 0112. A header with a brand, some links and a language switch tells a visitor where to read and nowhere to
    // act. `/become-a-seller` is a built route, not an invented one, and it is the single place a person can
    // begin putting a property on the site. Twice in the markup is correct and is checked as such: once in the
    // row from `sm` up, once at the head of the drawer, which is where a phone wants it.
    const en = render('en');
    expect(en.match(/href="\/become-a-seller"/g)).toHaveLength(2);
    expect(en).toContain(LABELS.action);
    // The reader's own language, like every other address in the chrome.
    expect(render('ar').match(/href="\/ar\/become-a-seller"/g)).toHaveLength(2);
  });

  it('keeps the plain chrome on the account and authentication surfaces', () => {
    // Owner decision 2 (0094). Those surfaces get the brand and the locale switch owner decision 8 makes part of
    // the application, and nothing else — no catalogue doors and no drawer to hold them.
    const html = render('en', false);
    expect(html).toContain('href="/"');
    expect(html).toContain('hrefLang="ar"');
    for (const href of ['/listings', '/services', '/categories']) expect(html).not.toContain(`href="${href}"`);
    expect(html).not.toContain(LABELS.menu);
    // The action is public-surface only, for the same reason the doors are (0112).
    expect(html).not.toContain('become-a-seller');
    expect(html).not.toContain(LABELS.action);
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

  it('is a step darker than the band above it, so the page has a visible end', () => {
    // The defect this fixes was found in a screenshot and by nothing else: the footer and a closing `value_props`
    // band were both `surface-ink` with a hairline between them, so the page ended in roughly seven hundred
    // pixels of unbroken emerald. A hairline divides regions inside one surface; ending a page needs a change of
    // value, which is what `surface-ink-deep` is.
    expect(html).toContain('bg-surface-ink-deep');
    expect(html).not.toContain('bg-surface-ink ');
  });

  it('groups its links under headings instead of one flat row', () => {
    // Before 0112 it was the lockup and three links in a single line: no grouping, no headings, and nothing a
    // person scanning for "terms" or "contact" could aim at.
    expect(html).toContain(FOOTER_LABELS.browseHeading);
    expect(html).toContain(FOOTER_LABELS.legalHeading);
    // Two named navigation landmarks, so the groups are structure rather than a visual arrangement.
    expect(html.match(/<nav aria-label=/g)).toHaveLength(2);
  });

  it('carries the policy addresses the route map fixes, in the reader’s language', () => {
    // Code, not composition — the same reasoning owner decision 8 applies to the locale switch. The composed
    // footer menu remains the mechanism for everything else and renders above these.
    for (const href of ['/ar/help', '/ar/contact', '/ar/terms', '/ar/privacy', '/ar/cookies']) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it('shows no office column at all until the office has set something (0113)', () => {
    // The default fixture passes no `office`, which is the state the platform ships in. An empty column with a
    // heading over nothing would be worse than no column: it would read as a site whose details failed to load.
    expect(html).not.toContain(FOOTER_LABELS.officeHeading);
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('mailto:');
  });

  it('shows exactly the office details that are set, and nothing for the rest', () => {
    // A field the office has not filled in is absent from the data (`public_site_settings` omits it) and must
    // be absent from the page. This fixture sets two of the six.
    const partial = renderToStaticMarkup(
      <SiteFooter
        copyright="© 2026 السوق"
        siteName="السوق"
        locale="ar"
        labels={FOOTER_LABELS}
        office={{ telephone: '+20 2 1234 5678', hours: 'السبت إلى الخميس، ١٠ص – ٨م' }}
        publicSurface
      />,
    );
    expect(partial).toContain(FOOTER_LABELS.officeHeading);
    expect(partial).toContain('+20 2 1234 5678');
    expect(partial).toContain(FOOTER_LABELS.hoursLabel);
    // The telephone is pressable, and the href carries only what a dialler can use.
    expect(partial).toContain('href="tel:+20212345678"');
    // And the four that were not set leave no label, no row and no gap behind them.
    expect(partial).not.toContain(FOOTER_LABELS.whatsappLabel);
    expect(partial).not.toContain(FOOTER_LABELS.emailLabel);
    expect(partial).not.toContain('mailto:');
  });

  it('sends a social link out without a referrer, and renders the office label rather than the host', () => {
    const social = renderToStaticMarkup(
      <SiteFooter
        copyright="© 2026 السوق"
        siteName="السوق"
        locale="ar"
        labels={FOOTER_LABELS}
        office={{ socialLinks: [{ label: 'فيسبوك', url: 'https://example.com/office' }] }}
        publicSurface
      />,
    );
    expect(social).toContain('href="https://example.com/office"');
    expect(social).toContain('rel="noreferrer"');
    expect(social).toContain('فيسبوك');
  });

  it('shows the full lockup, tagline and all, which is the one place with room for it', () => {
    // `BrandLockup` exists because the supplied horizontal lockup's tagline renders about five pixels tall at
    // header size. At the foot of a page, at 56px, it is legible — so the footer uses the supplied file whole.
    expect(html).toContain('/brand/horizontal-white.svg');
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
