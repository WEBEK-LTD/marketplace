import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { AttributeDetailView } from '../../../../../admin/components/attributes-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';
import { adminPath } from '../../../../../admin/paths';

/**
 * One attribute: what it is, whether sellers are asked it, and the options it offers.
 *
 * Gated on the same `catalog.attribute.manage` as the vocabulary. There is no rename control, no retype control and
 * no delete control on this screen, because none of those routes exists: the key and the data type are identity
 * every stored answer refers to, and every table that references an attribute restricts deletion.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ definitionId: string }> }) {
  const section = sectionByHref('/catalog/attributes');
  if (section === null) return null;

  const { definitionId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Attributes')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('attributes.title')}</Heading>
          <p className="mt-2">
            <Link className="text-sm underline hover:no-underline" href={adminPath('/catalog/attributes')}>
              {t('backToVocabulary')}
            </Link>
          </p>
          <AttributeDetailView definitionId={definitionId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
