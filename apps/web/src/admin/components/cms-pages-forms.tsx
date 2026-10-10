'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  CMS_PAGE_EXCERPT_MAX,
  CMS_PAGE_META_DESCRIPTION_MAX,
  CMS_PAGE_META_TITLE_MAX,
  CMS_PAGE_STATUSES,
  CMS_PAGE_TEMPLATES,
  CMS_PAGE_TITLE_MAX,
  type CmsPageStatus,
  type CmsPageTemplate,
  type CmsPageTranslation,
} from '@repo/contracts';
import { adminApiPath } from '../paths';

/**
 * The CMS page controls.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No account, and no way to name one.** The API resolves the caller from their own session; `created_by`
 *   and `updated_by` are written by the database from that account, so there is no field here that could carry
 *   somebody else's.
 * - **No timestamp.** `published_at`, `archived_at` and `updated_at` are the database's, set by 0030's own
 *   lifecycle trigger.
 * - **No status on the settings form, and no slug on the status form.** The two are separate requests against
 *   separate routes, so a colleague fixing a typo in an address cannot publish a half-written page by sending
 *   one extra field — and the contract drops such a field rather than relying on this file to omit it.
 * - **No transition matrix.** All four states are offered, because which edges exist is 0030's rule; a reduced
 *   list here would refuse a change the database allows, and an illegal one is refused upstream with a reason
 *   this form shows.
 * - **No optimistic state.** Typed text survives a failed request, because a colleague who lost a page body
 *   has lost more than the request.
 *
 * **Refusals are shown in the server's words, mapped by code.** Four are expected and each means something
 * different to the person reading it: the page has not been written yet, the change is not an allowed one, the
 * address belongs to another page's history, or the cover image named is not in the library.
 *
 * **The cover form carries an identifier, not a picker, and no image.** The `cms-media` bucket is private and
 * nothing here is signed, so what an attached cover looks like in this console is its stored object path and
 * the alt text somebody wrote — rendered by the server beside this form, never fetched from here. Attaching
 * needs `cms.page.manage` and nothing else: a page editor is not required to hold `cms.media.manage`.
 */

const BUTTON_CLASS = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';
const LABEL_CLASS = 'block text-sm font-medium text-ink-body';
const HINT_CLASS = 'mt-1 text-xs text-ink-muted';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const response = await fetch(adminApiPath(path), {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let code: string | null = null;
    try {
      const payload = JSON.parse(await response.text()) as { code?: unknown };
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      code = null;
    }
    return { status: response.status, code };
  } catch {
    return { status: null, code: null };
  }
}

/** One sentence for one outcome. A code the screen knows gets its own; everything else is the generic one. */
function messageFor(
  outcome: Outcome,
  copy: { readonly failed: string; readonly invalid: string } & Partial<{
    readonly slugTaken: string;
    readonly localeRequired: string;
    readonly notAllowed: string;
    readonly coverMissing: string;
  }>,
): string {
  if (outcome.code === 'CMS_PAGE_SLUG_TAKEN' && copy.slugTaken !== undefined) return copy.slugTaken;
  if (outcome.code === 'CMS_PAGE_LOCALE_REQUIRED' && copy.localeRequired !== undefined) {
    return copy.localeRequired;
  }
  if (outcome.code === 'CMS_PAGE_TRANSITION_NOT_ALLOWED' && copy.notAllowed !== undefined) {
    return copy.notAllowed;
  }
  if (outcome.code === 'CMS_PAGE_COVER_MEDIA_MISSING' && copy.coverMissing !== undefined) {
    return copy.coverMissing;
  }
  if (outcome.status === 400) return copy.invalid;
  return copy.failed;
}

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {message}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Create                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageCreateCopy {
  readonly slugLabel: string;
  readonly slugHint: string;
  readonly pageKeyLabel: string;
  readonly pageKeyHint: string;
  readonly templateLabel: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly slugTaken: string;
  readonly invalid: string;
}

export function CmsPageCreateForm({ copy }: { readonly copy: CmsPageCreateCopy }) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [pageKey, setPageKey] = useState('');
  const [template, setTemplate] = useState<CmsPageTemplate>('standard');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('POST', '/api/cms/pages', {
      slug: slug.trim(),
      // An empty key is absent rather than empty: the column is nullable and a blank key is not a key.
      ...(pageKey.trim() === '' ? {} : { pageKey: pageKey.trim() }),
      template,
    });

    if (outcome.status === 201) {
      // The typed values are left alone deliberately: the refresh reveals the new draft in the list, and a
      // colleague adding several pages keeps their place.
      setSlug('');
      setPageKey('');
      router.refresh();
    } else {
      setProblem(messageFor(outcome, copy));
    }
    setBusy(false);
  }

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-create-slug">
          {copy.slugLabel}
        </label>
        <input
          id="cms-create-slug"
          className={FIELD_CLASS}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          required
          maxLength={120}
        />
        <p className={HINT_CLASS}>{copy.slugHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-create-key">
          {copy.pageKeyLabel}
        </label>
        <input
          id="cms-create-key"
          className={FIELD_CLASS}
          value={pageKey}
          onChange={(event) => setPageKey(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.pageKeyHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-create-template">
          {copy.templateLabel}
        </label>
        <select
          id="cms-create-template"
          className={FIELD_CLASS}
          value={template}
          onChange={(event) => setTemplate(event.target.value as CmsPageTemplate)}
        >
          {CMS_PAGE_TEMPLATES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <Problem message={problem} />
      <button className={BUTTON_CLASS} type="submit" disabled={busy || slug.trim() === ''}>
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Settings                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageSettingsCopy {
  readonly slugLabel: string;
  readonly slugHint: string;
  readonly pageKeyLabel: string;
  readonly pageKeyHint: string;
  readonly templateLabel: string;
  readonly sortOrderLabel: string;
  readonly indexableLabel: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly slugTaken: string;
  readonly invalid: string;
}

export function CmsPageSettingsForm({
  pageId,
  initial,
  copy,
}: {
  readonly pageId: string;
  readonly initial: {
    readonly slug: string;
    readonly pageKey: string | null;
    readonly template: CmsPageTemplate;
    readonly sortOrder: number;
    readonly isIndexable: boolean;
  };
  readonly copy: CmsPageSettingsCopy;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(initial.slug);
  const [pageKey, setPageKey] = useState(initial.pageKey ?? '');
  const [template, setTemplate] = useState<CmsPageTemplate>(initial.template);
  const [sortOrder, setSortOrder] = useState(String(initial.sortOrder));
  const [isIndexable, setIsIndexable] = useState(initial.isIndexable);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('PATCH', '/api/cms/pages', {
      pageId,
      slug: slug.trim(),
      // An empty string clears the key, which is a different request from not sending the field at all.
      pageKey: pageKey.trim(),
      template,
      sortOrder: Number(sortOrder),
      isIndexable,
    });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setBusy(false);
  }

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-slug">
          {copy.slugLabel}
        </label>
        <input
          id="cms-slug"
          className={FIELD_CLASS}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          required
          maxLength={120}
        />
        <p className={HINT_CLASS}>{copy.slugHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-key">
          {copy.pageKeyLabel}
        </label>
        <input
          id="cms-key"
          className={FIELD_CLASS}
          value={pageKey}
          onChange={(event) => setPageKey(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.pageKeyHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-template">
          {copy.templateLabel}
        </label>
        <select
          id="cms-template"
          className={FIELD_CLASS}
          value={template}
          onChange={(event) => setTemplate(event.target.value as CmsPageTemplate)}
        >
          {CMS_PAGE_TEMPLATES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-order">
          {copy.sortOrderLabel}
        </label>
        <input
          id="cms-order"
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={100000}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="cms-indexable"
          type="checkbox"
          checked={isIndexable}
          onChange={(event) => setIsIndexable(event.target.checked)}
        />
        <label className="text-sm text-ink-body" htmlFor="cms-indexable">
          {copy.indexableLabel}
        </label>
      </div>

      <Problem message={problem} />
      <button className={BUTTON_CLASS} type="submit" disabled={busy}>
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Cover image (0099)                                                                                */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageCoverCopy {
  readonly mediaIdLabel: string;
  readonly mediaIdHint: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly invalid: string;
  readonly coverMissing: string;
  /**
   * Present only when a cover is attached, because that is the only time the control renders.
   *
   * A client component's whole props object is serialised into the RSC payload, so a label passed
   * unconditionally would ship on every page view for a button nobody can see. The server decides.
   */
  readonly remove?: string;
}

/**
 * Attaching or removing a page's cover image.
 *
 * Two operations and no third: saving an id attaches that entry, and removing sends an empty value, which the
 * BFF reads as the explicit null that clears. Leaving a cover alone is not submitting this form.
 */
export function CmsPageCoverForm({
  pageId,
  initialMediaId,
  copy,
}: {
  readonly pageId: string;
  readonly initialMediaId: string | null;
  readonly copy: CmsPageCoverCopy;
}) {
  const router = useRouter();
  const [mediaId, setMediaId] = useState(initialMediaId ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function put(value: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('PUT', '/api/cms/pages/cover', { pageId, mediaId: value });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setBusy(false);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await put(mediaId.trim());
  }

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-cover-media">
          {copy.mediaIdLabel}
        </label>
        <input
          id="cms-cover-media"
          className={FIELD_CLASS}
          value={mediaId}
          onChange={(event) => setMediaId(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <p className={HINT_CLASS}>{copy.mediaIdHint}</p>
      </div>

      <Problem message={problem} />

      <div className="flex flex-wrap items-center gap-3">
        <button className={BUTTON_CLASS} type="submit" disabled={busy}>
          {busy ? copy.working : copy.submit}
        </button>
        {copy.remove === undefined ? null : (
          <button
            className={DANGER_CLASS}
            type="button"
            disabled={busy}
            onClick={() => {
              setMediaId('');
              void put('');
            }}
          >
            {copy.remove}
          </button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Lifecycle                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageStatusCopy {
  readonly statusLabel: string;
  readonly scheduledForLabel: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly localeRequired: string;
  readonly notAllowed: string;
  readonly invalid: string;
  readonly confirm: string;
}

export function CmsPageStatusForm({
  pageId,
  current,
  copy,
}: {
  readonly pageId: string;
  readonly current: CmsPageStatus;
  readonly copy: CmsPageStatusCopy;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<CmsPageStatus>(current);
  const [scheduledFor, setScheduledFor] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    // It asks twice: publishing something, and taking something published away from the public, are both
    // worth being sure about.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setProblem(null);

    const outcome = await send('PUT', '/api/cms/pages/status', {
      pageId,
      status,
      // Required for `scheduled` and refused for everything else, which is the contract's rule and the
      // database's constraint.
      ...(status === 'scheduled' ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
    });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setConfirming(false);
    setBusy(false);
  }

  const needsMoment = status === 'scheduled';

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-status">
          {copy.statusLabel}
        </label>
        <select
          id="cms-status"
          className={FIELD_CLASS}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as CmsPageStatus);
            setConfirming(false);
          }}
        >
          {CMS_PAGE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {needsMoment ? (
        <div>
          <label className={LABEL_CLASS} htmlFor="cms-scheduled">
            {copy.scheduledForLabel}
          </label>
          <input
            id="cms-scheduled"
            className={FIELD_CLASS}
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
            required
          />
        </div>
      ) : null}

      <Problem message={problem} />
      {confirming ? <p className="text-sm text-ink-body">{copy.confirm}</p> : null}
      <button
        className={BUTTON_CLASS}
        type="submit"
        disabled={busy || (needsMoment && scheduledFor === '')}
      >
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Translations                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsPageTranslationCopy {
  readonly localeLabel: string;
  readonly titleLabel: string;
  readonly bodyLabel: string;
  readonly bodyHint: string;
  readonly excerptLabel: string;
  readonly metaTitleLabel: string;
  readonly metaDescriptionLabel: string;
  readonly submit: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly working: string;
  readonly failed: string;
  readonly localeRequired: string;
  readonly invalid: string;
}

/** The locales the public site serves. Which codes exist is the database's; this offers the two it seeds. */
const LOCALES = ['en', 'ar'] as const;

export function CmsPageTranslationForm({
  pageId,
  translations,
  copy,
}: {
  readonly pageId: string;
  readonly translations: readonly CmsPageTranslation[];
  readonly copy: CmsPageTranslationCopy;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState<string>(LOCALES[0]);
  const existing = translations.find((entry) => entry.localeCode === locale);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [excerpt, setExcerpt] = useState(existing?.excerpt ?? '');
  const [metaTitle, setMetaTitle] = useState(existing?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(existing?.metaDescription ?? '');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Switching locale loads what that locale already holds, or empties the fields when it holds nothing. */
  function chooseLocale(next: string): void {
    const found = translations.find((entry) => entry.localeCode === next);
    setLocale(next);
    setTitle(found?.title ?? '');
    setBody(found?.body ?? '');
    setExcerpt(found?.excerpt ?? '');
    setMetaTitle(found?.metaTitle ?? '');
    setMetaDescription(found?.metaDescription ?? '');
    setRemoving(false);
    setProblem(null);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('PUT', '/api/cms/pages/translations', {
      pageId,
      localeCode: locale,
      title: title.trim(),
      body,
      // A blank optional is sent as null, which the writer stores as absent rather than as an empty string, so
      // a page never carries a blank meta tag.
      excerpt: excerpt.trim() === '' ? null : excerpt.trim(),
      metaTitle: metaTitle.trim() === '' ? null : metaTitle.trim(),
      metaDescription: metaDescription.trim() === '' ? null : metaDescription.trim(),
    });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setBusy(false);
  }

  async function remove(): Promise<void> {
    if (busy) return;
    if (!removing) {
      setRemoving(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await send('POST', '/api/cms/pages/translations/remove', { pageId, localeCode: locale });
    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setRemoving(false);
    setBusy(false);
  }

  return (
    <form className="mt-6 max-w-2xl space-y-4 border-t border-hairline pt-6" onSubmit={save}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-locale">
          {copy.localeLabel}
        </label>
        <select
          id="cms-locale"
          className={FIELD_CLASS}
          value={locale}
          onChange={(event) => chooseLocale(event.target.value)}
        >
          {LOCALES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-title">
          {copy.titleLabel}
        </label>
        <input
          id="cms-title"
          className={FIELD_CLASS}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={CMS_PAGE_TITLE_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-body">
          {copy.bodyLabel}
        </label>
        <textarea
          id="cms-body"
          className={FIELD_CLASS}
          rows={14}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
        />
        <p className={HINT_CLASS}>{copy.bodyHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-excerpt">
          {copy.excerptLabel}
        </label>
        <textarea
          id="cms-excerpt"
          className={FIELD_CLASS}
          rows={2}
          value={excerpt}
          onChange={(event) => setExcerpt(event.target.value)}
          maxLength={CMS_PAGE_EXCERPT_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-meta-title">
          {copy.metaTitleLabel}
        </label>
        <input
          id="cms-meta-title"
          className={FIELD_CLASS}
          value={metaTitle}
          onChange={(event) => setMetaTitle(event.target.value)}
          maxLength={CMS_PAGE_META_TITLE_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="cms-meta-description">
          {copy.metaDescriptionLabel}
        </label>
        <textarea
          id="cms-meta-description"
          className={FIELD_CLASS}
          rows={2}
          value={metaDescription}
          onChange={(event) => setMetaDescription(event.target.value)}
          maxLength={CMS_PAGE_META_DESCRIPTION_MAX}
        />
      </div>

      <Problem message={problem} />
      {removing ? <p className="text-sm text-ink-body">{copy.removeConfirm}</p> : null}

      <div className="flex gap-3">
        <button className={BUTTON_CLASS} type="submit" disabled={busy || title.trim() === '' || body.trim() === ''}>
          {busy ? copy.working : copy.submit}
        </button>
        {existing === undefined ? null : (
          <button className={DANGER_CLASS} type="button" onClick={remove} disabled={busy}>
            {copy.remove}
          </button>
        )}
      </div>
    </form>
  );
}
