import { isCmsPageSlug, publicCmsPagePath } from '@repo/config';
import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { CmsPageDetail, CmsPageSummary } from '@repo/contracts';
import { readCmsPageDetail, readCmsPageList, type CmsPagesResult } from '../server/bff';
import { currentStaffSession } from '../server/current-staff';
import { CmsPageCreateForm, CmsPageSettingsForm, CmsPageStatusForm, CmsPageTranslationForm } from './cms-pages-forms';

/**
 * The CMS pages section (authored static pages).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the detail
 * because reading and managing are separate seeded keys, and a reader who holds only the first sees the page
 * and no form. Deciding that here from a role name would be a second, weaker copy of a rule the database
 * already applies.
 *
 * **Nothing here decides a business rule.** Which lifecycle transitions exist, whether a page may be published,
 * and whether a locale may be removed are all the database's; these screens offer the actions and show the
 * refusal in the words the API sent.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-neutral-200 pb-2 pr-4 font-medium text-neutral-600';
const TD = 'border-b border-neutral-100 py-2 pr-4 align-top text-neutral-900';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not a page of rows. */
async function problem<T>(result: CmsPagesResult<T>): Promise<string | null> {
  const t = await getTranslations('Cms');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('cursorBody');
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
/* The authoring list                                                                                */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageListProps {
  readonly cursor: string | null;
  readonly status: string | null;
}

export async function CmsPageList({ cursor, status }: CmsPageListProps) {
  const t = await getTranslations('Cms');
  const result = await readCmsPageList({ cursor, status }, { cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { items, nextCursor } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('listIntro')}</p>

      {items.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnTitle')}</th>
              <th className={TH}>{t('columnSlug')}</th>
              <th className={TH}>{t('columnStatus')}</th>
              <th className={TH}>{t('columnLocales')}</th>
              <th className={TH}>{t('columnIndexable')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((page) => (
              <CmsPageRow key={page.id} page={page} untitled={t('untitled')} />
            ))}
          </tbody>
        </table>
      )}

      {nextCursor === null ? null : (
        <p className="mt-4">
          <Link
            className="text-sm text-neutral-900 underline"
            href={`/cms/pages?cursor=${encodeURIComponent(nextCursor)}${
              status === null ? '' : `&status=${encodeURIComponent(status)}`
            }`}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </section>
  );
}

function CmsPageRow({ page, untitled }: { page: CmsPageSummary; untitled: string }) {
  return (
    <tr>
      <td className={TD}>
        <Link className="text-neutral-900 underline" href={`/cms/pages/${page.id}`}>
          {page.title ?? untitled}
        </Link>
      </td>
      <td className={TD}>
        <code>{page.slug}</code>
      </td>
      <td className={TD}>{page.status}</td>
      <td className={TD}>
        {/* An empty set is the state that cannot be published, so it is shown as a dash rather than blank. */}
        {page.translatedLocales.length === 0 ? '—' : page.translatedLocales.join(', ')}
      </td>
      <td className={TD}>{page.isIndexable ? 'yes' : 'no'}</td>
      <td className={TD}>
        <time dateTime={page.updatedAt}>{page.updatedAt.slice(0, 10)}</time>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Creating needs `cms.page.manage`, which is a different key from the one that opens this section.
 *
 * The list response does not carry a capability flag — only the detail does, because that is where a console
 * needs it per page — so this panel asks the session the same way the page's own gate does. A colleague holding
 * only `cms.page.read` gets **no panel at all**, not a disabled one: the words of a control somebody cannot use
 * have no business in their RSC payload, and the API would answer their submission with a 404 anyway.
 */
export async function CmsPageCreatePanel() {
  const t = await getTranslations('Cms');
  const session = await currentStaffSession();
  if (session.kind !== 'ok' || !session.session.permissions.includes('cms.page.manage')) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('createHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('createIntro')}</p>
      <CmsPageCreateForm
        copy={{
          slugLabel: t('slugLabel'),
          slugHint: t('slugHint'),
          pageKeyLabel: t('pageKeyLabel'),
          pageKeyHint: t('pageKeyHint'),
          templateLabel: t('templateLabel'),
          submit: t('createSubmit'),
          working: t('working'),
          failed: t('createFailed'),
          slugTaken: t('slugTaken'),
          invalid: t('invalid'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One page                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function CmsPageDetailView({ pageId }: { readonly pageId: string | undefined }) {
  const t = await getTranslations('Cms');
  const result = await readCmsPageDetail(pageId, { cookieHeader: await cookieHeader() });

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

  const page = result.data;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{page.slug}</Heading>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-600">{t('columnStatus')}</dt>
          <dd className="text-neutral-900">{page.status}</dd>
          <dt className="text-neutral-600">{t('templateLabel')}</dt>
          <dd className="text-neutral-900">{page.template}</dd>
          <dt className="text-neutral-600">{t('pageKeyLabel')}</dt>
          <dd className="text-neutral-900">{page.pageKey ?? '—'}</dd>
          <dt className="text-neutral-600">{t('columnIndexable')}</dt>
          <dd className="text-neutral-900">{page.isIndexable ? 'yes' : 'no'}</dd>
          <dt className="text-neutral-600">{t('sortOrderLabel')}</dt>
          <dd className="text-neutral-900">{page.sortOrder}</dd>
          <dt className="text-neutral-600">{t('publishedAtLabel')}</dt>
          <dd className="text-neutral-900">{page.publishedAt ?? '—'}</dd>
          <dt className="text-neutral-600">{t('scheduledForLabel')}</dt>
          <dd className="text-neutral-900">{page.scheduledFor ?? '—'}</dd>
          <dt className="text-neutral-600">{t('publicAddressLabel')}</dt>
          <dd className="text-neutral-900">
            {isCmsPageSlug(page.slug) ? (
              <code>{publicCmsPagePath('en', page.slug)}</code>
            ) : (
              t('publicAddressNone')
            )}
          </dd>
        </dl>

        {isCmsPageSlug(page.slug) ? null : (
          // Said out loud, because the alternative is an operator publishing a page and finding out from a
          // visitor. The public site serves a fixed list of addresses, fixed by the specification's route map;
          // a page whose address is not on it is authored, stored and versioned perfectly well and reaches
          // nobody. Changing the list is a code change, which is why this reports the fact rather than
          // offering to fix it.
          <Message tone="empty" title={t('publicAddressNoneTitle')} body={t('publicAddressNoneBody')} />
        )}

        {page.previousSlugs.length === 0 ? null : (
          <div className="mt-4">
            <p className="text-sm font-medium text-neutral-700">{t('previousSlugsHeading')}</p>
            <p className="mt-1 text-sm text-neutral-600">{t('previousSlugsNote')}</p>
            <ul className="mt-2 text-sm text-neutral-900">
              {page.previousSlugs.map((slug) => (
                <li key={slug}>
                  <code>{slug}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {page.canManage ? null : <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />}
      </section>

      {page.canManage ? <CmsPageControls page={page} /> : null}
      <CmsPageTranslations page={page} />
    </>
  );
}

async function CmsPageControls({ page }: { readonly page: CmsPageDetail }) {
  const t = await getTranslations('Cms');
  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('settingsHeading')}</Heading>
        <CmsPageSettingsForm
          pageId={page.id}
          initial={{
            slug: page.slug,
            pageKey: page.pageKey,
            template: page.template,
            sortOrder: page.sortOrder,
            isIndexable: page.isIndexable,
          }}
          copy={{
            slugLabel: t('slugLabel'),
            slugHint: t('slugRenameHint'),
            pageKeyLabel: t('pageKeyLabel'),
            pageKeyHint: t('pageKeyHint'),
            templateLabel: t('templateLabel'),
            sortOrderLabel: t('sortOrderLabel'),
            indexableLabel: t('indexableLabel'),
            submit: t('settingsSubmit'),
            working: t('working'),
            failed: t('settingsFailed'),
            slugTaken: t('slugTaken'),
            invalid: t('invalid'),
          }}
        />
      </section>

      <section className={CARD}>
        <Heading level={2}>{t('statusHeading')}</Heading>
        <p className="mt-1 text-sm text-neutral-600">{t('statusIntro')}</p>
        <CmsPageStatusForm
          pageId={page.id}
          current={page.status}
          copy={{
            statusLabel: t('columnStatus'),
            scheduledForLabel: t('scheduledForLabel'),
            submit: t('statusSubmit'),
            working: t('working'),
            failed: t('statusFailed'),
            localeRequired: t('localeRequired'),
            notAllowed: t('transitionNotAllowed'),
            invalid: t('invalid'),
            confirm: t('statusConfirm'),
          }}
        />
      </section>
    </>
  );
}

async function CmsPageTranslations({ page }: { readonly page: CmsPageDetail }) {
  const t = await getTranslations('Cms');
  return (
    <section className={CARD}>
      <Heading level={2}>{t('translationsHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('translationsIntro')}</p>

      {page.translations.length === 0 ? (
        <Message tone="empty" title={t('noLocalesTitle')} body={t('noLocalesBody')} />
      ) : (
        <ul className="mt-4 space-y-3 text-sm">
          {page.translations.map((translation) => (
            <li key={translation.localeCode} className="rounded-md border border-neutral-200 p-3">
              <p className="font-medium text-neutral-900">
                <code>{translation.localeCode}</code> — {translation.title}
              </p>
              {translation.metaDescription === null ? null : (
                <p className="mt-1 text-neutral-600">{translation.metaDescription}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {page.canManage ? (
        <CmsPageTranslationForm
          pageId={page.id}
          translations={page.translations}
          copy={{
            localeLabel: t('localeLabel'),
            titleLabel: t('titleLabel'),
            bodyLabel: t('bodyLabel'),
            bodyHint: t('bodyHint'),
            excerptLabel: t('excerptLabel'),
            metaTitleLabel: t('metaTitleLabel'),
            metaDescriptionLabel: t('metaDescriptionLabel'),
            submit: t('translationSubmit'),
            remove: t('translationRemove'),
            removeConfirm: t('translationRemoveConfirm'),
            working: t('working'),
            failed: t('translationFailed'),
            localeRequired: t('localeRequired'),
            invalid: t('invalid'),
          }}
        />
      ) : null}
    </section>
  );
}
