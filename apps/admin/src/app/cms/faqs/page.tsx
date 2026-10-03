import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { FaqAddPanel, FaqList, FaqTopicsPanel } from '../../../components/faqs-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The help centre — the questions the site's own pages answer (0095).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes from
 * the section list rather than from a string typed here, so this page and the navigation entry pointing at it can
 * never disagree.
 *
 * The gate is `cms.faq.read`. **Authoring needs the separate `cms.faq.manage`**, which each panel asks the server
 * about rather than inferring from a role — so a reader sees the questions and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/cms/faqs');
  if (section === null) return null;

  const params = await searchParams;
  const topic = typeof params['topic'] === 'string' ? params['topic'] : undefined;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Faqs')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('faqs.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <FaqTopicsPanel />
          <FaqList topic={topic} />
          <FaqAddPanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
