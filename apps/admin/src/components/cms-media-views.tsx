import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { CmsMediaEntry } from '@repo/contracts';
import { readCmsMediaList, readCmsMediaUsage, type CmsMediaResult } from '../server/bff';
import {
  CmsMediaEntryControls,
  CmsMediaRemoveForm,
  CmsMediaUploadForm,
  type CmsMediaEntryCopy,
} from './cms-media-forms';

/**
 * The CMS media library section (0098).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **No image is rendered on this page until an operator asks for one.** The bucket is private and has no read policy,
 * so an image is viewable only through a signed URL issued per request; a page that previewed every row would mint a
 * live credential for each one and make a provider call per row. So the list shows what each entry *is* — its type,
 * its size, its dimensions, its alt text and how many things point at it — and a button fetches the picture.
 *
 * **Two things an operator could not otherwise work out are said out loud:**
 *
 *   1. **What this library is not yet used for.** Nothing public renders these images: a page cover, a blog cover and
 *      a share image all still hand out a path nothing resolves, and this increment deliberately did not change that
 *      (owner decision 4). An operator uploading a cover expecting it to appear would be waiting for something that
 *      is not going to happen.
 *   2. **What deleting does.** All six referencing columns are `on delete set null`, so the delete control is only
 *      rendered after the screen has fetched and shown every reference (owner decision 5).
 *
 * **There are no controls to hide.** This surface has one key, so a colleague who can see it can change it, and
 * `canManage` is reported by the API all the same rather than inferred from a role.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: CmsMediaResult<T>): Promise<string | null> {
  const t = await getTranslations('CmsMedia');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error' | 'note'; title: string; body: string }) {
  const classes =
    tone === 'error'
      ? 'border-red-200 bg-red-50'
      : tone === 'note'
        ? 'border-amber-200 bg-amber-50'
        : 'border-neutral-200 bg-neutral-50';
  return (
    <div className={`mt-4 rounded-md border p-4 ${classes}`}>
      <p className="font-medium text-neutral-900">{title}</p>
      <p className="mt-1 text-sm text-neutral-700">{body}</p>
    </div>
  );
}

/** A byte count an operator can read. Not a business rule and nothing depends on it. */
function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function CmsMediaUploadPanel() {
  const t = await getTranslations('CmsMedia');
  return (
    <section className={CARD}>
      <Heading level={2}>{t('uploadHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-700">{t('uploadIntro')}</p>
      {/* Owner decisions 2 and 6, said out loud rather than discovered through a refusal. */}
      <Message tone="note" title={t('rulesTitle')} body={t('rulesBody')} />
      <CmsMediaUploadForm
        copy={{
          fileLabel: t('fileLabel'),
          fileHint: t('fileHint'),
          altTextEnLabel: t('altTextEnLabel'),
          altTextArLabel: t('altTextArLabel'),
          altTextHint: t('altTextHint'),
          submit: t('uploadSubmit'),
          working: t('working'),
          tooLarge: t('tooLarge'),
          wrongType: t('wrongType'),
          failed: t('uploadRefused'),
          invalid: t('invalid'),
          notAllowed: t('notAllowed'),
          objectMissing: t('objectMissing'),
          pathTaken: t('pathTaken'),
          uploadFailed: t('bytesFailed'),
        }}
      />
    </section>
  );
}

export async function CmsMediaList({
  cursor,
  usageFor,
}: {
  readonly cursor?: string | undefined;
  /** The one entry whose references — and therefore whose delete control — this response renders. */
  readonly usageFor?: string | undefined;
}) {
  const t = await getTranslations('CmsMedia');
  const result = await readCmsMediaList(
    { cursor: cursor ?? null },
    { cookieHeader: await cookieHeader() },
  );
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

  const entryCopy: CmsMediaEntryCopy = {
    altTextEnLabel: t('altTextEnLabel'),
    altTextArLabel: t('altTextArLabel'),
    save: t('saveAltText'),
    saveFailed: t('saveFailed'),
    invalid: t('invalid'),
    preview: t('preview'),
    previewFailed: t('previewFailed'),
    previewHint: t('previewHint'),
    hidePreview: t('hidePreview'),
  };

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      {/* Owner decision 4: an operator has to know that nothing public shows these yet. */}
      <Message tone="note" title={t('notUsedYetTitle')} body={t('notUsedYetBody')} />

      {items.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <ul className="mt-4 space-y-6">
          {items.map((entry) => (
            <li className="border-t border-neutral-100 pt-4" key={entry.id}>
              <Entry entry={entry} copy={entryCopy} showUsage={entry.id === usageFor} />
            </li>
          ))}
        </ul>
      )}

      {nextCursor === null ? null : (
        <p className="mt-6">
          <Link
            className="text-sm text-neutral-900 underline"
            href={`/cms/media?cursor=${encodeURIComponent(nextCursor)}`}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </section>
  );
}

async function Entry({
  entry,
  copy,
  showUsage,
}: {
  readonly entry: CmsMediaEntry;
  readonly copy: CmsMediaEntryCopy;
  readonly showUsage: boolean;
}) {
  const t = await getTranslations('CmsMedia');

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* The path, because it is what a stored object *is*. It is not an address and nothing links to it. */}
        <p className="break-all font-mono text-xs text-neutral-700">{entry.objectPath}</p>
        <p className="text-xs text-neutral-500">
          {entry.contentType} · {kilobytes(entry.byteSize)}
          {entry.width === null || entry.height === null ? '' : ` · ${entry.width}×${entry.height}`}
        </p>
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        {entry.usageCount === 0
          ? t('usedNowhere')
          : t('usedByCount', { count: entry.usageCount })}
      </p>

      <CmsMediaEntryControls
        altTextAr={entry.altTextAr ?? ''}
        altTextEn={entry.altTextEn ?? ''}
        copy={copy}
        mediaId={entry.id}
      />

      {/*
        Owner decision 5, made structural. The references and the delete control are rendered by the same server
        response and by no other, so there is no way to reach a delete without the list of what it would blank —
        and nothing about deleting is in any payload until an operator asks for this entry's references.
      */}
      {showUsage ? (
        <UsagePanel mediaId={entry.id} />
      ) : (
        <p className="mt-3">
          <Link className="text-sm text-neutral-900 underline" href={`/cms/media?usage=${entry.id}`}>
            {t('checkUsage')}
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * One entry's references, and the only delete control in this console.
 *
 * Read on the server, which is what makes owner decision 5 a property of the response rather than of a click: if the
 * references cannot be read, no delete is offered at all.
 */
async function UsagePanel({ mediaId }: { readonly mediaId: string }) {
  const t = await getTranslations('CmsMedia');
  const result = await readCmsMediaUsage(mediaId, { cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    return (
      <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
        <p className="text-sm text-red-800">{t('usageFailed')}</p>
      </div>
    );
  }

  const { references } = result.data;

  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-sm font-medium text-neutral-900">{t('usageHeading')}</p>
      {references.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-700">{t('usageNone')}</p>
      ) : (
        <ul className="mt-1 list-disc ps-5 text-sm text-neutral-700">
          {references.map((reference) => (
            <li key={`${reference.entityType}-${reference.column}-${reference.label}`}>
              {reference.entityType} · {reference.label} · <code>{reference.column}</code>
            </li>
          ))}
        </ul>
      )}
      <CmsMediaRemoveForm
        copy={{ submit: t('remove'), confirm: t('removeConfirm'), failed: t('removeFailed') }}
        mediaId={mediaId}
      />
      <p className="mt-2">
        <Link className="text-sm text-neutral-700 underline" href="/cms/media">
          {t('hideUsage')}
        </Link>
      </p>
    </div>
  );
}
