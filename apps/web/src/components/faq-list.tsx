import { Heading } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import type { PublicFaqEntry } from '@repo/contracts';

/**
 * The help-centre questions a page shows (0095).
 *
 * **Which page shows which questions is decided before this renders.** A page's `page_key` is the topic (owner
 * decision 1), the API returns the published entries of that topic in the operator's order, and this component
 * renders what it is handed.
 *
 * **Nothing renders when there is nothing to show** (owner decision 2). No heading, no empty state, no "no
 * questions yet" — a page whose topic has nothing published looks exactly as it did before this increment.
 *
 * **An answer is plain text, rendered as paragraphs split on blank lines** (owner decision 3) — the same rule
 * `cms-page-view` already applies to a page body, for the same reason: the column is `text`, nobody authored
 * markup, and interpreting it as markup would be inventing a format.
 *
 * **No structured data** (owner decision 4). There is no `FAQPage` JSON-LD here and no script of any kind: the
 * questions are content in the page, and what a crawler is told about this address is still entirely 0091's.
 *
 * A server component, because the questions are content and the HTML has to carry them for a crawler and for a
 * visitor with no JavaScript.
 */

/** Splits on blank lines. An answer with no blank line is one paragraph, which is the common case. */
function paragraphsOf(answer: string): readonly string[] {
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

export async function FaqList({
  locale,
  entries,
}: {
  readonly locale: string;
  readonly entries: readonly PublicFaqEntry[];
}) {
  // Owner decision 2: no section at all, which is why this is the first thing the component does.
  if (entries.length === 0) return null;

  const t = await getTranslations({ locale, namespace: 'Faq' });

  return (
    <section className="mt-12 border-t border-hairline pt-8">
      <Heading level={2}>{t('heading')}</Heading>
      <dl className="mt-6 space-y-8">
        {entries.map((entry) => (
          <div key={entry.faqId}>
            <dt className="text-base font-semibold text-ink-strong">{entry.question}</dt>
            <dd className="mt-2 max-w-prose">
              {paragraphsOf(entry.answer).map((paragraph, index) => (
                <p className={index === 0 ? 'text-ink-body' : 'mt-3 text-ink-body'} key={index}>
                  {paragraph}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
