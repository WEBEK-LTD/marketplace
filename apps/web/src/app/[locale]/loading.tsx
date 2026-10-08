import { PageContainer, SkeletonCardGrid, SkeletonText } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

/**
 * The segment's loading state.
 *
 * **Skeletons shaped like the catalogue, not a line of text.** The old state was the word "Loading" centred on
 * an empty page, which told a person nothing about what was coming and let the whole layout jump into place when
 * it arrived. These placeholders have the geometry of a heading and a grid of cards, so the page is laid out
 * before the data lands and the content fills a shape that is already there.
 *
 * It announces once, through the grid's own `role="status"` and its label, rather than once per placeholder.
 * The pulse stops under `prefers-reduced-motion`; the shape alone still says "not yet".
 */
export default async function Loading() {
  const t = await getTranslations('Loading');
  return (
    <PageContainer>
      <div className="py-10">
        <SkeletonText lines={2} className="max-w-md" />
        <div className="mt-8">
          <SkeletonCardGrid count={8} label={t('label')} />
        </div>
      </div>
    </PageContainer>
  );
}
