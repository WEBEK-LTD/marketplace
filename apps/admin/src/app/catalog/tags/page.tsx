import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { TagCreatePanel, TagVocabulary } from '../../../components/attributes-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The tag vocabulary — the free labels a seller may put on a listing.
 *
 * Gated on `catalog.tag.manage`, which is a **separate key from the attribute vocabulary's**: holding one grants
 * nothing on the other, and the two sections are separate for that reason rather than for tidiness.
 *
 * A tag is created active, unlike an attribute: there is nothing to fill in first. There is no rename control for a
 * slug and no delete control, because neither route exists — `listing_tags` restricts deletion, so hiding is what a
 * tag's retirement is.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/catalog/tags');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Attributes')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('tags.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('tagsIntro')}</p>
          <TagVocabulary />
          <TagCreatePanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
