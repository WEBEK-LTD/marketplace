import { Heading } from '@repo/ui';
import type { PublicCmsPage } from '@repo/contracts';

/**
 * One CMS static page, rendered.
 *
 * **The body is rendered as plain text with paragraph breaks, and that is a deliberate limit rather than a
 * simplification.** `page_translations.body` is a `text` column and neither the specification nor the schema
 * says what format it holds — there is no format column, no sanitiser anywhere in this repository and no
 * markup library in it either. Interpreting the column as HTML would be inventing a format *and* opening an
 * injection path through content an administrator typed; interpreting it as Markdown would be inventing a
 * format and adding a dependency. So blank lines separate paragraphs, every character is escaped by React as
 * text, and a richer format is a decision somebody makes before it is a feature somebody builds.
 *
 * `lang` and `dir` are set from the page's **resolved** locale, not from the URL's. A page asked for in Arabic
 * that only exists in English comes back in English, and saying `lang="ar"` over English text would be a lie
 * to a screen reader and to a translation tool alike.
 */

export interface CmsPageViewProps {
  readonly page: PublicCmsPage;
}

/** Splits on blank lines. A body with no blank line is one paragraph, which is the common case. */
function paragraphsOf(body: string): readonly string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function CmsPageView({ page }: CmsPageViewProps) {
  const paragraphs = paragraphsOf(page.body);

  return (
    <article lang={page.resolvedLocale} dir={page.resolvedLocale === 'ar' ? 'rtl' : 'ltr'}>
      <Heading level={1}>{page.title}</Heading>
      {page.excerpt === null ? null : (
        <p className="mt-3 max-w-prose text-lg text-neutral-700">{page.excerpt}</p>
      )}
      <div className="mt-6 max-w-prose space-y-4 text-neutral-800">
        {paragraphs.map((paragraph, index) => (
          // The index is the key because a paragraph has no identity of its own: this list is derived from one
          // string and is replaced whole whenever that string changes.
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    </article>
  );
}
