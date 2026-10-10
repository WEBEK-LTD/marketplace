import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { FaqDetailView } from '../../../../../admin/components/faqs-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';

/**
 * One help-centre entry: what it asks, what it answers, and whether any public page shows it.
 *
 * Gated on the section's own `cms.faq.read`. The controls render only when the server reports `canManage`, which is
 * the separate `cms.faq.manage` key tested in the database.
 *
 * An entry that does not exist and one this caller may not read both render the same message, because the API
 * answers both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ faqId: string }> }) {
  const section = sectionByHref('/cms/faqs');
  if (section === null) return null;

  const { faqId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Faqs')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('faqs.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('detailIntro')}</p>
          <FaqDetailView faqId={faqId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
