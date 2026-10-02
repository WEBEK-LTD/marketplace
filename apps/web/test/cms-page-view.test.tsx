import type { PublicCmsPage } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CmsPageView } from '../src/components/cms-page-view';

/**
 * A CMS static page's body as markup.
 *
 * The assertions that matter:
 *
 * **The body is text, never markup.** A body containing a script tag, an anchor or an entity must come out
 * escaped. This is the test that would fail if somebody later reached for `dangerouslySetInnerHTML` to make
 * authored content render "properly" — which is exactly the change that would turn an administrator's typing
 * into an injection path.
 *
 * **`lang` and `dir` follow the resolved locale, not the requested one.** A page asked for in Arabic that only
 * exists in English is English text, and labelling it `lang="ar"` would mislead a screen reader and a
 * translation tool alike.
 *
 * **Paragraphs come from blank lines**, which is the one formatting rule this renderer has.
 */

const PAGE: PublicCmsPage = {
  slug: 'terms',
  pageKey: 'terms',
  template: 'legal',
  isIndexable: true,
  resolvedLocale: 'en',
  title: 'Terms of Service',
  excerpt: 'The short version.',
  body: 'First paragraph.\n\nSecond paragraph.',
  metaTitle: 'Terms',
  metaDescription: 'Our terms.',
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

describe('the page body', () => {
  it('shows the title, the excerpt and the body', () => {
    const markup = renderToStaticMarkup(<CmsPageView page={PAGE} />);
    expect(markup).toContain('Terms of Service');
    expect(markup).toContain('The short version.');
    expect(markup).toContain('First paragraph.');
    expect(markup).toContain('Second paragraph.');
  });

  it('separates paragraphs on blank lines', () => {
    const markup = renderToStaticMarkup(<CmsPageView page={PAGE} />);
    expect(markup).toContain('<p class="whitespace-pre-line">First paragraph.</p>');
    expect(markup).toContain('<p class="whitespace-pre-line">Second paragraph.</p>');
  });

  it('treats a body with no blank line as one paragraph', () => {
    const markup = renderToStaticMarkup(
      <CmsPageView page={{ ...PAGE, body: 'One line.\nStill the same paragraph.' }} />,
    );
    expect((markup.match(/whitespace-pre-line/g) ?? []).length).toBe(1);
  });

  it('escapes the body rather than rendering it as markup', () => {
    const markup = renderToStaticMarkup(
      <CmsPageView
        page={{
          ...PAGE,
          body: '<script>alert(1)</script>\n\n<a href="https://example.test">link</a> & more',
        }}
      />,
    );
    // Not one tag from the body survives as a tag.
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<a href="https://example.test">');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&amp;');
  });

  it('escapes the title and the excerpt too', () => {
    const markup = renderToStaticMarkup(
      <CmsPageView page={{ ...PAGE, title: '<b>Terms</b>', excerpt: '<i>short</i>' }} />,
    );
    expect(markup).not.toContain('<b>Terms</b>');
    expect(markup).not.toContain('<i>short</i>');
    expect(markup).toContain('&lt;b&gt;');
  });

  it('omits the excerpt entirely when there is none', () => {
    const markup = renderToStaticMarkup(<CmsPageView page={{ ...PAGE, excerpt: null }} />);
    expect(markup).not.toContain('text-lg');
  });

  it('marks the language and direction from the resolved locale', () => {
    const english = renderToStaticMarkup(<CmsPageView page={PAGE} />);
    expect(english).toContain('lang="en"');
    expect(english).toContain('dir="ltr"');

    const arabic = renderToStaticMarkup(
      <CmsPageView page={{ ...PAGE, resolvedLocale: 'ar', title: 'شروط الخدمة', body: 'النص.' }} />,
    );
    expect(arabic).toContain('lang="ar"');
    expect(arabic).toContain('dir="rtl"');
    expect(arabic).toContain('شروط الخدمة');
  });

  it('says English when English is what came back, whatever was asked for', () => {
    // The fallback case: the page was requested in Arabic and the API resolved to English.
    const markup = renderToStaticMarkup(<CmsPageView page={{ ...PAGE, resolvedLocale: 'en' }} />);
    expect(markup).toContain('lang="en"');
    expect(markup).not.toContain('lang="ar"');
  });

  it('shows nothing about the page that a visitor has no use for', () => {
    const markup = renderToStaticMarkup(<CmsPageView page={PAGE} />);
    // The meta fields build a document head on the server; they are not content.
    expect(markup).not.toContain('Our terms.');
    // Nor are the timestamps, the template or the page key part of what a page says.
    expect(markup).not.toContain('2026-05-01');
    expect(markup).not.toContain('legal');
  });
});
