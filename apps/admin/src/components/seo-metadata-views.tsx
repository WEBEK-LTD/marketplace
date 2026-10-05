import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import {
  SEO_METADATA_WRITABLE_ENTITY_TYPES,
  type SeoMetadataDetail,
  type SeoMetadataEntry,
  type SeoMetadataWritableEntityType,
} from '@repo/contracts';
import { readSeoMetadataEntry, readSeoMetadataList, type SeoMetadataResult } from '../server/bff';
import { currentStaffSession } from '../server/current-staff';
import {
  SeoMetadataFilterForm,
  SeoMetadataRemoveForm,
  SeoMetadataSaveForm,
} from './seo-metadata-forms';

/**
 * The per-entity SEO metadata section.
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section receives
 * a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the detail
 * because reading and managing are separate seeded keys.
 *
 * **Both owner rules are shown from the server's answer too, never restated.** `canonicalIsHonoured` says whether a
 * stored canonical is read at all for this kind of surface, and `effectiveRobotsDirectives` says what the directives
 * will actually do. The screen reports those; it does not explain the rules and risk a different account of them.
 *
 * **It says what this section does not do.** There is no structured data, no site-wide default, and no `service` kind
 * — each of which an operator could reasonably expect, and each of which would be a silent disappointment.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-neutral-200 pb-2 pr-4 font-medium text-neutral-600';
const TD = 'border-b border-neutral-100 py-2 pr-4 align-top text-neutral-900';

/** The locales the public site serves. Which codes exist is the database's; this offers the two it seeds. */
const LOCALES = ['en', 'ar'] as const;

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not a page of rows. */
async function problem<T>(result: SeoMetadataResult<T>): Promise<string | null> {
  const t = await getTranslations('SeoMetadata');
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

/** The query a page link must keep, so paging does not silently drop a filter. */
function carried(entityType: string | null, locale: string | null): string {
  const params = new URLSearchParams();
  if (entityType !== null && entityType !== '') params.set('entityType', entityType);
  if (locale !== null && locale !== '') params.set('locale', locale);
  return params.toString();
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoMetadataListProps {
  readonly cursor: string | null;
  readonly entityType: string | null;
  readonly locale: string | null;
}

export async function SeoMetadataList({ cursor, entityType, locale }: SeoMetadataListProps) {
  const t = await getTranslations('SeoMetadata');
  const result = await readSeoMetadataList({ cursor, entityType, locale }, { cookieHeader: await cookieHeader() });
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
  const keep = carried(entityType, locale);
  const filtered = entityType !== null || locale !== null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('listIntro')}</p>
      {/* Said out loud, because an operator cannot deduce either rule from anything on the screen. */}
      <Message tone="empty" title={t('rulesTitle')} body={t('rulesBody')} />

      <SeoMetadataFilterForm
        initial={{ entityType, locale }}
        kinds={SEO_METADATA_WRITABLE_ENTITY_TYPES}
        locales={LOCALES}
        copy={{
          kindLabel: t('kindLabel'),
          kindAny: t('kindAny'),
          localeLabel: t('localeLabel'),
          localeAny: t('localeAny'),
          submit: t('filterSubmit'),
          clear: t('filterClear'),
        }}
      />

      {items.length === 0 ? (
        <Message
          tone="empty"
          title={filtered ? t('noMatchesTitle') : t('emptyTitle')}
          body={filtered ? t('noMatchesBody') : t('emptyBody')}
        />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnTarget')}</th>
              <th className={TH}>{t('columnKind')}</th>
              <th className={TH}>{t('columnLocale')}</th>
              <th className={TH}>{t('columnTitle')}</th>
              <th className={TH}>{t('columnDirectives')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <SeoMetadataRow key={entry.id} entry={entry} untitled={t('untitled')} />
            ))}
          </tbody>
        </table>
      )}

      {nextCursor === null ? null : (
        <p className="mt-4">
          <Link
            className="text-sm text-neutral-900 underline"
            href={`/seo/metadata?cursor=${encodeURIComponent(nextCursor)}${keep === '' ? '' : `&${keep}`}`}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </section>
  );
}

function SeoMetadataRow({ entry, untitled }: { readonly entry: SeoMetadataEntry; readonly untitled: string }) {
  return (
    <tr>
      <td className={TD}>
        <Link className="text-neutral-900 underline" href={`/seo/metadata/${entry.id}`}>
          <code>{entry.routePath ?? entry.targetSlug ?? entry.entityId ?? '—'}</code>
        </Link>
      </td>
      <td className={TD}>{entry.entityType}</td>
      <td className={TD}>{entry.localeCode}</td>
      <td className={TD}>{entry.metaTitle ?? untitled}</td>
      <td className={TD}>
        {/* The stored set, as stored. What it will do is on the detail, from the server's own answer. */}
        <code>{entry.robotsDirectives.join(', ')}</code>
      </td>
      <td className={TD}>
        <time dateTime={entry.updatedAt}>{entry.updatedAt.slice(0, 10)}</time>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Adding                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding an override needs `seo.metadata.manage`, which is a different key from the one that opens this section.
 *
 * The list response carries no capability flag — only the detail does — so this panel asks the session the same way
 * the page's own gate does. A colleague holding only the read key gets **no panel at all**, not a disabled one.
 */
export async function SeoMetadataAddPanel() {
  const t = await getTranslations('SeoMetadata');
  const session = await currentStaffSession();
  if (session.kind !== 'ok' || !session.session.permissions.includes('seo.metadata.manage')) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('addHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('addIntro')}</p>
      <Message tone="empty" title={t('notHereTitle')} body={t('notHereBody')} />
      <SeoMetadataSaveForm locales={LOCALES} copy={await saveCopy()} />
    </section>
  );
}

/** The one set of labels the save form needs, in one place because two screens use it. */
async function saveCopy() {
  const t = await getTranslations('SeoMetadata');
  return {
    kindLabel: t('kindLabel'),
    kindHint: t('kindHint'),
    targetLabel: t('targetLabel'),
    targetHint: t('targetHint'),
    routeLabel: t('routeLabel'),
    routeHint: t('routeHint'),
    localeLabel: t('localeLabel'),
    metaTitleLabel: t('metaTitleLabel'),
    metaDescriptionLabel: t('metaDescriptionLabel'),
    canonicalLabel: t('canonicalLabel'),
    canonicalHint: t('canonicalHint'),
    directivesLabel: t('directivesLabel'),
    directivesHint: t('directivesHint'),
    ogTitleLabel: t('ogTitleLabel'),
    ogDescriptionLabel: t('ogDescriptionLabel'),
    shareMediaLabel: t('shareMediaLabel'),
    shareMediaHint: t('shareMediaHint'),
    replaceWarning: t('replaceWarning'),
    submit: t('saveSubmit'),
    working: t('working'),
    failed: t('saveFailed'),
    notAllowed: t('notAllowed'),
    targetUnknown: t('targetUnknown'),
    invalid: t('invalid'),
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* One override                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export async function SeoMetadataDetailView({ entryId }: { readonly entryId: string | undefined }) {
  const t = await getTranslations('SeoMetadata');
  const result = await readSeoMetadataEntry(entryId, { cookieHeader: await cookieHeader() });

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

  const entry = result.data;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{entry.routePath ?? entry.targetSlug ?? entry.entityId ?? '—'}</Heading>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-600">{t('columnKind')}</dt>
          <dd className="text-neutral-900">{entry.entityType}</dd>
          <dt className="text-neutral-600">{t('columnLocale')}</dt>
          <dd className="text-neutral-900">{entry.localeCode}</dd>
          <dt className="text-neutral-600">{t('storedCanonical')}</dt>
          <dd className="text-neutral-900">{entry.canonicalPath ?? '—'}</dd>
          <dt className="text-neutral-600">{t('effectiveCanonical')}</dt>
          <dd className="text-neutral-900">{entry.effectiveCanonicalPath ?? t('effectiveNone')}</dd>
          <dt className="text-neutral-600">{t('storedDirectives')}</dt>
          <dd className="text-neutral-900">
            <code>{entry.robotsDirectives.join(', ')}</code>
          </dd>
          <dt className="text-neutral-600">{t('effectiveDirectives')}</dt>
          <dd className="text-neutral-900">
            {entry.effectiveRobotsDirectives.length === 0 ? (
              t('effectiveNone')
            ) : (
              <code>{entry.effectiveRobotsDirectives.join(', ')}</code>
            )}
          </dd>
          <dt className="text-neutral-600">{t('shareMediaLabel')}</dt>
          <dd className="text-neutral-900">{entry.shareObjectPath ?? '—'}</dd>
          <dt className="text-neutral-600">{t('columnUpdated')}</dt>
          <dd className="text-neutral-900">
            <time dateTime={entry.updatedAt}>{entry.updatedAt}</time>
          </dd>
        </dl>

        {entry.canonicalIsHonoured || entry.canonicalPath === null ? null : (
          // The stored canonical will not be served for this kind of surface. Said plainly, because the field
          // accepted the value and an operator would otherwise have no way to know it does nothing.
          <Message tone="empty" title={t('canonicalIgnoredTitle')} body={t('canonicalIgnoredBody')} />
        )}

        {entry.robotsDirectives.length === entry.effectiveRobotsDirectives.length ? null : (
          // Some stored directive is permissive and has been dropped. The same reasoning.
          <Message tone="empty" title={t('directivesNarrowedTitle')} body={t('directivesNarrowedBody')} />
        )}

        {entry.canManage ? null : <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />}
      </section>

      {entry.canManage ? <SeoMetadataControls entry={entry} /> : null}
    </>
  );
}

async function SeoMetadataControls({ entry }: { readonly entry: SeoMetadataDetail }) {
  const t = await getTranslations('SeoMetadata');
  // Only the writable kinds reach the form. A stored blog entry can be read and removed and not rewritten, because
  // no blog surface exists to read it — which is the honest state rather than a form that reaches nobody.
  const writable = (SEO_METADATA_WRITABLE_ENTITY_TYPES as readonly string[]).includes(entry.entityType);

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('editHeading')}</Heading>
        {writable ? (
          <SeoMetadataSaveForm
            fixed={{
              entityType: entry.entityType as SeoMetadataWritableEntityType,
              entityId: entry.entityId,
              routePath: entry.routePath,
              localeCode: entry.localeCode,
            }}
            initial={{
              metaTitle: entry.metaTitle,
              metaDescription: entry.metaDescription,
              canonicalPath: entry.canonicalPath,
              robotsDirectives: entry.robotsDirectives,
              ogTitle: entry.ogTitle,
              ogDescription: entry.ogDescription,
              shareMediaId: entry.shareMediaId,
            }}
            locales={LOCALES}
            copy={await saveCopy()}
          />
        ) : (
          <Message tone="empty" title={t('notWritableTitle')} body={t('notWritableBody')} />
        )}
      </section>

      <section className={CARD}>
        <Heading level={2}>{t('removeHeading')}</Heading>
        <p className="mt-1 text-sm text-neutral-600">{t('removeIntro')}</p>
        <SeoMetadataRemoveForm
          entryId={entry.id}
          copy={{
            remove: t('remove'),
            removeConfirm: t('removeConfirm'),
            working: t('working'),
            failed: t('removeFailed'),
            invalid: t('invalid'),
          }}
        />
      </section>
    </>
  );
}
