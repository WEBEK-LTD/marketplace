import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from './require-staff';
import { sectionByHref } from '../server/console-sections';

/**
 * One console section, as 7-F ships it (Phase 7-F).
 *
 * **The permission comes from the section list, not from the page.** A page names its own route and the
 * list says which key opens it, so a link in the navigation and the page it points at read the same
 * entry. There is no string repeated in two places for the two to disagree about.
 *
 * **The body is an honest empty state.** The section exists, the reader may open it, and its tools
 * arrive in the increment that builds them — which is what the page says. There is no placeholder
 * dashboard, no sample row and no invented statistic: 7-F is the shell, and a fabricated number here
 * would be worse than an empty page, because somebody would read it.
 *
 * A route whose `href` is not in the list renders nothing at all rather than defaulting to permitted.
 * That branch is unreachable from the routes in this application; it exists so that adding a page
 * without adding its entry fails closed.
 */
export async function SectionPage({ href }: { readonly href: string }) {
  const section = sectionByHref(href);
  if (section === null) return null;

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-12">
          <SectionBody id={section.id} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

async function SectionBody({ id }: { readonly id: string }) {
  const [t, sectionLabels] = await Promise.all([
    getTranslations('Console'),
    getTranslations('Sections'),
  ]);

  return (
    <>
      <Heading level={1}>{sectionLabels(`${id}.title`)}</Heading>
      <p className="mt-2 max-w-prose text-neutral-600">{sectionLabels(`${id}.description`)}</p>
      <div className="mt-8 rounded-lg border border-neutral-200 p-6">
        <p className="text-base font-medium text-neutral-900">{t('comingSoonTitle')}</p>
        <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('comingSoon')}</p>
      </div>
    </>
  );
}
