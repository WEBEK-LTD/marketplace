import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { HomepageSectionDetail, HomepageServedSectionType } from '@repo/contracts';
import { HOMEPAGE_SERVED_SECTION_TYPES } from '@repo/contracts';
import { readHomepageSection, readHomepageSections, type HomepageResult } from '../server/bff';
import {
  HomepageBackLink,
  HomepageCreateForm,
  HomepageEditForm,
  HomepageReorderForm,
  HomepageSectionStateForm,
} from './homepage-forms';
import { adminPath } from '../paths';

/**
 * The homepage composition section (0093).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the list and
 * on the detail, because reading and composing are separate seeded keys.
 *
 * **Three things an operator could not otherwise work out are said out loud.** A section the homepage will not
 * render is marked and explained. A section whose chosen rows have all disappeared is marked and explained, because
 * the public homepage skips it silently and this is the only place the reason exists. And the section types this
 * increment does not offer — a banner strip above all — are named rather than simply missing.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-neutral-200 pb-2 pr-4 font-medium text-neutral-600';
const TD = 'border-b border-neutral-100 py-2 pr-4 align-top text-neutral-900';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: HomepageResult<T>): Promise<string | null> {
  const t = await getTranslations('Homepage');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('invalid');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error'; title: string; body: string }) {
  return (
    <div
      className={`mt-4 rounded-md border p-4 ${
        tone === 'error' ? 'border-red-200 bg-red-50' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <p className="font-medium text-neutral-900">{title}</p>
      <p className="mt-1 text-sm text-neutral-700">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function HomepageSectionList() {
  const t = await getTranslations('Homepage');
  const result = await readHomepageSections({ cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { sections, canManage } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('listIntro')}</p>
      {/* Said out loud, because an operator cannot deduce any of it from anything on the screen. */}
      <Message tone="empty" title={t('notHereTitle')} body={t('notHereBody')} />

      {sections.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnKey')}</th>
              <th className={TH}>{t('columnType')}</th>
              <th className={TH}>{t('columnTitle')}</th>
              <th className={TH}>{t('columnVisible')}</th>
              <th className={TH}>{t('columnNotes')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <tr key={section.id}>
                <td className={TD}>
                  <Link className="text-neutral-900 underline" href={adminPath(`/cms/homepage/${section.id}`)}>
                    <code>{section.sectionKey}</code>
                  </Link>
                </td>
                <td className={TD}>
                  <code>{section.sectionType}</code>
                </td>
                <td className={TD}>{section.titleEn ?? t('untitled')}</td>
                <td className={TD}>{section.isActive ? t('shown') : t('hidden')}</td>
                <td className={TD}>
                  {/* Two states an operator would otherwise have to discover from the live site. */}
                  {!section.isServed ? <p className="text-amber-700">{t('notServed')}</p> : null}
                  {!section.isConfigured ? <p className="text-red-700">{t('notConfigured')}</p> : null}
                  {section.isServed && section.isConfigured ? '—' : null}
                </td>
                <td className={TD}>
                  <time dateTime={section.updatedAt}>{section.updatedAt.slice(0, 10)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Decided here, not inside the form: a client component's whole props object is serialised into the RSC
          payload, so rendering the form and letting it return null would still put its labels in the page's own
          source. Fewer than two sections means there is no order to change and no words for one. */}
      {!canManage || sections.length < 2 ? null : (
        <HomepageReorderForm
          sections={sections.map((section) => ({
            id: section.id,
            label: `${section.sectionKey} — ${section.sectionType}`,
          }))}
          copy={{
            notice: t('reorderNotice'),
            up: t('moveUp'),
            down: t('moveDown'),
            submit: t('reorderSubmit'),
            failed: t('saveFailed'),
            invalid: t('invalid'),
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Adding                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding a section needs `cms.homepage.manage`, a different key from the one that opens this section.
 *
 * The capability comes from the list response, which this panel reads anyway. A colleague holding only the read key
 * gets **no panel at all**, not a disabled one.
 */
export async function HomepageAddPanel() {
  const t = await getTranslations('Homepage');
  const result = await readHomepageSections({ cookieHeader: await cookieHeader() });
  if (result.kind !== 'ok' || !result.data.canManage) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('addHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('addIntro')}</p>
      <Message tone="empty" title={t('typesTitle')} body={t('typesBody')} />
      <HomepageCreateForm copy={await createCopy()} />
    </section>
  );
}

/** The labels both the create and the edit form need, in one place because two screens use them. */
async function createCopy() {
  const t = await getTranslations('Homepage');
  return {
    keyLabel: t('keyLabel'),
    keyHint: t('keyHint'),
    typeLabel: t('typeLabel'),
    titleEnLabel: t('titleEnLabel'),
    titleArLabel: t('titleArLabel'),
    configLabel: t('configLabel'),
    configHint: t('configHint'),
    hiddenNotice: t('hiddenNotice'),
    submit: t('saveSubmit'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    keyTaken: t('keyTaken'),
    notAllowed: t('notAllowed'),
    configMalformed: t('configMalformed'),
    configMismatched: t('configMismatched'),
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* One section                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function HomepageSectionDetailView({ sectionId }: { readonly sectionId: string | undefined }) {
  const t = await getTranslations('Homepage');
  const result = await readHomepageSection(sectionId, { cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('detailHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const section = result.data;
  const served = (HOMEPAGE_SERVED_SECTION_TYPES as readonly string[]).includes(section.sectionType);

  return (
    <>
      <HomepageSummaryPanel section={section} />
      {!section.canManage ? (
        <section className={CARD}>
          <Heading level={2}>{t('readOnlyHeading')}</Heading>
          <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />
        </section>
      ) : (
        <>
          {served ? (
            <section className={CARD}>
              <Heading level={2}>{t('editHeading')}</Heading>
              <HomepageEditForm
                sectionId={section.id}
                initial={{
                  sectionKey: section.sectionKey,
                  sectionType: section.sectionType as HomepageServedSectionType,
                  titleEn: section.titleEn ?? '',
                  titleAr: section.titleAr ?? '',
                  subtitleEn: section.subtitleEn ?? '',
                  subtitleAr: section.subtitleAr ?? '',
                  config: JSON.stringify(section.config ?? {}, null, 2),
                  sortOrder: section.sortOrder,
                }}
                copy={{
                  ...(await createCopy()),
                  subtitleEnLabel: t('subtitleEnLabel'),
                  subtitleArLabel: t('subtitleArLabel'),
                  sortOrderLabel: t('sortOrderLabel'),
                  noPublishNotice: t('noPublishNotice'),
                }}
              />
            </section>
          ) : (
            <section className={CARD}>
              <Heading level={2}>{t('editHeading')}</Heading>
              {/* An unserved type cannot be edited here, because this form only offers the served ones. Saying so
                  is better than offering a type picker that would silently convert the section into another kind. */}
              <Message tone="empty" title={t('notServedTitle')} body={t('notServedBody')} />
            </section>
          )}
          <section className={CARD}>
            <Heading level={2}>{t('stateHeading')}</Heading>
            <p className="mt-1 text-sm text-neutral-600">{t('stateIntro')}</p>
            <HomepageSectionStateForm
              sectionId={section.id}
              isActive={section.isActive}
              copy={{
                // One label, chosen here: a client component's whole props object reaches the browser, so passing
                // both would put the wrong word in the page's own source.
                toggle: section.isActive ? t('hideSection') : t('showSection'),
                remove: t('removeSection'),
                removeConfirm: t('removeConfirm'),
                failed: t('saveFailed'),
                invalid: t('invalid'),
              }}
            />
          </section>
        </>
      )}
    </>
  );
}

async function HomepageSummaryPanel({ section }: { readonly section: HomepageSectionDetail }) {
  const t = await getTranslations('Homepage');
  const counted = section.chosenCount > 0 || section.renderableCount > 0;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('detailHeading')}</Heading>
      <p className="mt-2 text-sm">
        <HomepageBackLink label={t('backToList')} />
      </p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Row label={t('fieldKey')} value={<code>{section.sectionKey}</code>} />
        <Row label={t('fieldType')} value={<code>{section.sectionType}</code>} />
        <Row label={t('fieldVisible')} value={section.isActive ? t('shown') : t('hidden')} />
        <Row label={t('fieldOrder')} value={String(section.sortOrder)} />
      </dl>

      {!section.isServed ? (
        <Message tone="empty" title={t('notServedTitle')} body={t('notServedBody')} />
      ) : null}
      {!section.isConfigured ? (
        <Message tone="error" title={t('notConfiguredTitle')} body={t('notConfiguredBody')} />
      ) : null}

      {/* Owner decision C, explained where it can be. The public homepage skips a section with nothing left to
          show, and these two numbers are the only place the reason exists. */}
      {counted ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-neutral-700">{t('countsHeading')}</p>
          <p className="mt-1 text-sm text-neutral-700">
            {t('countsBody', { chosen: section.chosenCount, renderable: section.renderableCount })}
          </p>
          {section.isActive && section.renderableCount === 0 ? (
            <Message tone="error" title={t('skippedTitle')} body={t('skippedBody')} />
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <p className="text-sm font-medium text-neutral-700">{t('storedConfigHeading')}</p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs">
          {JSON.stringify(section.config ?? {}, null, 2)}
        </pre>
      </div>
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-neutral-600">{label}</dt>
      <dd className="mt-0.5 text-neutral-900">{value}</dd>
    </div>
  );
}
