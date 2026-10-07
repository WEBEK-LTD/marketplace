import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../admin/components/require-staff';
import { sectionsFor } from '../../admin/server/console-sections';
import { currentStaffSession } from '../../admin/server/current-staff';

/**
 * The console home (Phase 7-F).
 *
 * A card for each section the reader may open, and nothing else. **No dashboard, no counts, no KPIs and
 * no statistics** — 7-F builds the shell, and a number on this page would be a number nobody has
 * approved a source for.
 *
 * The whole body sits inside {@link RequireStaff}, which is what keeps everybody else from receiving
 * any of it: a signed-out visitor, a buyer, a seller and staff who have not completed a second factor
 * all get their own answer and never the list below. The list itself is built from the same permission
 * set the gate used, so it can never offer a section the section's own page would refuse.
 */
export default async function ConsoleHomePage() {
  return (
    <RequireStaff>
      <PageContainer>
        <div className="py-12">
          <HomeBody />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

async function HomeBody() {
  const [t, sectionLabels, result] = await Promise.all([
    getTranslations('Console'),
    getTranslations('Sections'),
    currentStaffSession(),
  ]);

  // Unreachable in practice: the gate above returns before this renders unless the session is usable.
  if (result.kind !== 'ok') return null;
  const sections = sectionsFor(result.session.permissions);

  return (
    <>
      <Heading level={1}>{t('title')}</Heading>
      <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('sectionsLabel')}>
        {sections.map((section) => (
          <li key={section.id}>
            <Link
              href={section.href}
              className="block h-full rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
            >
              <span className="block text-base font-medium text-neutral-900">
                {sectionLabels(`${section.id}.title`)}
              </span>
              <span className="mt-1 block text-sm text-neutral-600">
                {sectionLabels(`${section.id}.description`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
