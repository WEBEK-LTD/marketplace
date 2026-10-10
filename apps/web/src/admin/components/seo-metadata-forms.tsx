'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  SEO_DIRECTIVES,
  SEO_META_DESCRIPTION_MAX,
  SEO_META_TITLE_MAX,
  SEO_METADATA_WRITABLE_ENTITY_TYPES,
  SEO_OG_DESCRIPTION_MAX,
  SEO_OG_TITLE_MAX,
  SEO_PATH_MAX,
  type SeoDirective,
  type SeoMetadataWritableEntityType,
} from '@repo/contracts';
import { adminApiPath, adminPath } from '../paths';

/**
 * The metadata-override controls.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No structured data.** The column exists and has no reader, so there is no field for it and nothing a browser
 *   sends could reach one.
 * - **No account and no timestamp.** The API resolves the author from the session; `updated_by` and `updated_at` are
 *   the database's.
 * - **No site-wide defaults.** Those are a separate cluster behind a separate key.
 * - **No `service` kind.** A service is a `listings` row, so its metadata is written as a `listing`.
 * - **No optimistic state.** Typed text survives a failed request.
 *
 * **A save is a replace, and the form says so.** Every field is submitted on every save, because the API clears what
 * it is not given — so the form that edits one field has to carry the others as they are, and a person needs to be
 * told that an emptied box empties the stored value.
 *
 * **Two rules are stated where they bite, from the server's own answer.** Whether a canonical is read at all comes
 * back as `canonicalIsHonoured`, and what the directives will actually do comes back as `effectiveRobotsDirectives`;
 * the screen shows those rather than restating the rules and risking a different account of them.
 */

const BUTTON_CLASS = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';
const LABEL_CLASS = 'block text-sm font-medium text-ink-body';
const HINT_CLASS = 'mt-1 text-xs text-ink-muted';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(method: 'PUT' | 'POST', path: string, body: Record<string, unknown>): Promise<Outcome> {
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
    readonly notAllowed: string;
    readonly targetUnknown: string;
  }>,
): string {
  if (outcome.code === 'SEO_METADATA_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
  if (outcome.code === 'SEO_METADATA_TARGET_UNKNOWN' && copy.targetUnknown !== undefined) return copy.targetUnknown;
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
/* Filters                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoMetadataFilterCopy {
  readonly kindLabel: string;
  readonly kindAny: string;
  readonly localeLabel: string;
  readonly localeAny: string;
  readonly submit: string;
  readonly clear: string;
}

/** The two filters, as a plain `GET` form, so a filtered list has a real URL that can be shared and reloaded. */
export function SeoMetadataFilterForm({
  initial,
  kinds,
  locales,
  copy,
}: {
  readonly initial: { readonly entityType: string | null; readonly locale: string | null };
  readonly kinds: readonly string[];
  readonly locales: readonly string[];
  readonly copy: SeoMetadataFilterCopy;
}) {
  const [entityType, setEntityType] = useState(initial.entityType ?? '');
  const [locale, setLocale] = useState(initial.locale ?? '');

  return (
    <form className="mt-4 flex flex-wrap items-end gap-3" method="get" action={adminPath('/seo/metadata')}>
      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-kind">
          {copy.kindLabel}
        </label>
        <select
          id="metadata-kind"
          className={FIELD_CLASS}
          name="entityType"
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
        >
          <option value="">{copy.kindAny}</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-locale">
          {copy.localeLabel}
        </label>
        <select
          id="metadata-locale"
          className={FIELD_CLASS}
          name="locale"
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
        >
          <option value="">{copy.localeAny}</option>
          {locales.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>

      <button className={BUTTON_CLASS} type="submit">
        {copy.submit}
      </button>
      {entityType === '' && locale === '' ? null : (
        <Link className={SECONDARY_CLASS} href={adminPath('/seo/metadata')}>
          {copy.clear}
        </Link>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writing one override                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoMetadataSaveCopy {
  readonly kindLabel: string;
  readonly kindHint: string;
  readonly targetLabel: string;
  readonly targetHint: string;
  readonly routeLabel: string;
  readonly routeHint: string;
  readonly localeLabel: string;
  readonly metaTitleLabel: string;
  readonly metaDescriptionLabel: string;
  readonly canonicalLabel: string;
  readonly canonicalHint: string;
  readonly directivesLabel: string;
  readonly directivesHint: string;
  readonly ogTitleLabel: string;
  readonly ogDescriptionLabel: string;
  readonly shareMediaLabel: string;
  readonly shareMediaHint: string;
  readonly replaceWarning: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly notAllowed: string;
  readonly targetUnknown: string;
  readonly invalid: string;
}

/**
 * The one form that writes an override, used for a new one and for an existing one alike.
 *
 * It is the same form in both places because the API's operation is the same: one surface and one locale have one
 * row, and this is that row. When it is editing an existing entry the kind, the target and the locale are fixed,
 * because changing any of them would not be editing this row — it would be writing a different one and leaving this
 * one behind.
 */
export function SeoMetadataSaveForm({
  fixed,
  initial,
  locales,
  copy,
}: {
  /** Set when editing: which row this is. Absent when adding, and then the three are chosen. */
  readonly fixed?: {
    readonly entityType: SeoMetadataWritableEntityType;
    readonly entityId: string | null;
    readonly routePath: string | null;
    readonly localeCode: string;
  };
  readonly initial?: {
    readonly metaTitle: string | null;
    readonly metaDescription: string | null;
    readonly canonicalPath: string | null;
    readonly robotsDirectives: readonly string[];
    readonly ogTitle: string | null;
    readonly ogDescription: string | null;
    readonly shareMediaId: string | null;
  };
  readonly locales: readonly string[];
  readonly copy: SeoMetadataSaveCopy;
}) {
  const router = useRouter();
  const [entityType, setEntityType] = useState<SeoMetadataWritableEntityType>(
    fixed?.entityType ?? SEO_METADATA_WRITABLE_ENTITY_TYPES[0],
  );
  const [entityId, setEntityId] = useState(fixed?.entityId ?? '');
  const [routePath, setRoutePath] = useState(fixed?.routePath ?? '');
  const [localeCode, setLocaleCode] = useState(fixed?.localeCode ?? (locales[0] ?? 'en'));
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? '');
  const [canonicalPath, setCanonicalPath] = useState(initial?.canonicalPath ?? '');
  const [directives, setDirectives] = useState<readonly string[]>(initial?.robotsDirectives ?? ['index', 'follow']);
  const [ogTitle, setOgTitle] = useState(initial?.ogTitle ?? '');
  const [ogDescription, setOgDescription] = useState(initial?.ogDescription ?? '');
  const [shareMediaId, setShareMediaId] = useState(initial?.shareMediaId ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const isRoute = entityType === 'route';
  const editing = fixed !== undefined;

  function toggle(directive: SeoDirective, on: boolean): void {
    setDirectives((held) => (on ? [...held.filter((d) => d !== directive), directive] : held.filter((d) => d !== directive)));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('PUT', '/api/seo/metadata', {
      entityType,
      ...(isRoute ? { routePath: routePath.trim() } : { entityId: entityId.trim() }),
      localeCode,
      // Every field, every time. A save is a replace, so sending only what changed would clear the rest.
      metaTitle: metaTitle.trim() === '' ? null : metaTitle.trim(),
      metaDescription: metaDescription.trim() === '' ? null : metaDescription.trim(),
      canonicalPath: canonicalPath.trim() === '' ? null : canonicalPath.trim(),
      robotsDirectives: directives,
      ogTitle: ogTitle.trim() === '' ? null : ogTitle.trim(),
      ogDescription: ogDescription.trim() === '' ? null : ogDescription.trim(),
      shareMediaId: shareMediaId.trim() === '' ? null : shareMediaId.trim(),
    });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setBusy(false);
  }

  return (
    <form className="mt-4 max-w-2xl space-y-4" onSubmit={submit}>
      {editing ? null : (
        <>
          <div>
            <label className={LABEL_CLASS} htmlFor="metadata-save-kind">
              {copy.kindLabel}
            </label>
            <select
              id="metadata-save-kind"
              className={FIELD_CLASS}
              value={entityType}
              onChange={(event) => setEntityType(event.target.value as SeoMetadataWritableEntityType)}
            >
              {SEO_METADATA_WRITABLE_ENTITY_TYPES.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <p className={HINT_CLASS}>{copy.kindHint}</p>
          </div>

          {isRoute ? (
            <div>
              <label className={LABEL_CLASS} htmlFor="metadata-save-route">
                {copy.routeLabel}
              </label>
              <input
                id="metadata-save-route"
                className={FIELD_CLASS}
                value={routePath}
                onChange={(event) => setRoutePath(event.target.value)}
                required
                maxLength={SEO_PATH_MAX}
              />
              <p className={HINT_CLASS}>{copy.routeHint}</p>
            </div>
          ) : (
            <div>
              <label className={LABEL_CLASS} htmlFor="metadata-save-target">
                {copy.targetLabel}
              </label>
              <input
                id="metadata-save-target"
                className={FIELD_CLASS}
                value={entityId}
                onChange={(event) => setEntityId(event.target.value)}
                required
              />
              <p className={HINT_CLASS}>{copy.targetHint}</p>
            </div>
          )}

          <div>
            <label className={LABEL_CLASS} htmlFor="metadata-save-locale">
              {copy.localeLabel}
            </label>
            <select
              id="metadata-save-locale"
              className={FIELD_CLASS}
              value={localeCode}
              onChange={(event) => setLocaleCode(event.target.value)}
            >
              {locales.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-title">
          {copy.metaTitleLabel}
        </label>
        <input
          id="metadata-title"
          className={FIELD_CLASS}
          value={metaTitle}
          onChange={(event) => setMetaTitle(event.target.value)}
          maxLength={SEO_META_TITLE_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-description">
          {copy.metaDescriptionLabel}
        </label>
        <textarea
          id="metadata-description"
          className={FIELD_CLASS}
          rows={3}
          value={metaDescription}
          onChange={(event) => setMetaDescription(event.target.value)}
          maxLength={SEO_META_DESCRIPTION_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-canonical">
          {copy.canonicalLabel}
        </label>
        <input
          id="metadata-canonical"
          className={FIELD_CLASS}
          value={canonicalPath}
          onChange={(event) => setCanonicalPath(event.target.value)}
          maxLength={SEO_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.canonicalHint}</p>
      </div>

      <fieldset>
        <legend className={LABEL_CLASS}>{copy.directivesLabel}</legend>
        <p className={HINT_CLASS}>{copy.directivesHint}</p>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {SEO_DIRECTIVES.map((directive) => (
            <label key={directive} className="flex items-center gap-2 text-sm text-ink-strong">
              <input
                type="checkbox"
                checked={directives.includes(directive)}
                onChange={(event) => toggle(directive, event.target.checked)}
              />
              <code>{directive}</code>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-og-title">
          {copy.ogTitleLabel}
        </label>
        <input
          id="metadata-og-title"
          className={FIELD_CLASS}
          value={ogTitle}
          onChange={(event) => setOgTitle(event.target.value)}
          maxLength={SEO_OG_TITLE_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-og-description">
          {copy.ogDescriptionLabel}
        </label>
        <textarea
          id="metadata-og-description"
          className={FIELD_CLASS}
          rows={2}
          value={ogDescription}
          onChange={(event) => setOgDescription(event.target.value)}
          maxLength={SEO_OG_DESCRIPTION_MAX}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="metadata-share">
          {copy.shareMediaLabel}
        </label>
        <input
          id="metadata-share"
          className={FIELD_CLASS}
          value={shareMediaId}
          onChange={(event) => setShareMediaId(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.shareMediaHint}</p>
      </div>

      <p className="rounded-md border border-hairline bg-surface-sunken p-3 text-sm text-ink-body">
        {copy.replaceWarning}
      </p>

      <Problem message={problem} />
      <button
        className={BUTTON_CLASS}
        type="submit"
        disabled={busy || directives.length === 0 || (editing ? false : isRoute ? routePath.trim() === '' : entityId.trim() === '')}
      >
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Removing                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoMetadataRemoveCopy {
  readonly remove: string;
  readonly removeConfirm: string;
  readonly working: string;
  readonly failed: string;
  readonly invalid: string;
}

/** Removing an override returns the surface to the metadata it derives from its own content. It asks twice. */
export function SeoMetadataRemoveForm({
  entryId,
  copy,
}: {
  readonly entryId: string;
  readonly copy: SeoMetadataRemoveCopy;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove(): Promise<void> {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await send('POST', '/api/seo/metadata/remove', { entryId });
    if (outcome.status === 200) router.push(adminPath('/seo/metadata'));
    else setProblem(messageFor(outcome, copy));
    setConfirming(false);
    setBusy(false);
  }

  return (
    <div className="mt-4">
      <Problem message={problem} />
      {confirming ? <p className="mb-3 text-sm text-ink-body">{copy.removeConfirm}</p> : null}
      <button className={DANGER_CLASS} type="button" onClick={() => void remove()} disabled={busy}>
        {busy ? copy.working : copy.remove}
      </button>
    </div>
  );
}
