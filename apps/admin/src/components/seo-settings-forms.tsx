'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  SEO_DEFAULT_META_DESCRIPTION_MAX,
  SEO_DEFAULT_META_TITLE_MAX,
  SEO_ROBOTS_BODY_MAX,
  SEO_SITE_NAME_MAX,
} from '@repo/contracts';

/**
 * The site-wide SEO settings controls (0096).
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No media picker, and no image preview.** The share image is an identifier typed or kept as it was; the
 *   `cms-media` bucket is private and this platform has no media origin or signing capability, so a preview would
 *   promise something nothing can render (owner decision 8). The screen says so in words rather than showing a
 *   broken image.
 * - **No structured-data builder, and no schema.org vocabulary.** The organization document is a JSON object an
 *   operator pastes, stored and read by nothing (owner decision 4). Nothing here suggests what belongs in it,
 *   because what belongs in it is not decided.
 * - **No preview of `/robots.txt`.** The body is served verbatim and the document also carries a `Sitemap:` line
 *   that depends on a production origin which is not configured, so a rendering here would differ from the real
 *   document in a way nobody could see.
 * - **No "which locale is served" control.** That follows the platform's default locale and is not a setting of
 *   this surface; the screen reports it (owner decision 5).
 * - **No optimistic state.** Typed text survives a failed request, which matters more here than anywhere: a crawl
 *   policy is the kind of text somebody composed once.
 *
 * **A save sends every field, because a save is a replace.** The form is the row: whatever is left blank is cleared.
 * The screen says that out loud rather than leaving an operator to discover it.
 */

const BUTTON_CLASS = 'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const MONO_FIELD_CLASS =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs text-neutral-900';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-700';
const HINT_CLASS = 'mt-1 text-xs text-neutral-500';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(path: string, body: Record<string, unknown>, method: 'POST' | 'PUT'): Promise<Outcome> {
  try {
    const response = await fetch(path, {
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

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {message}
    </p>
  );
}

/** The copy one locale's form needs. */
export interface SeoSettingsFormCopy {
  readonly siteNameLabel: string;
  readonly siteNameHint: string;
  readonly defaultMetaTitleLabel: string;
  readonly defaultMetaTitleHint: string;
  readonly defaultMetaDescriptionLabel: string;
  readonly defaultMetaDescriptionHint: string;
  readonly shareMediaLabel: string;
  readonly shareMediaHint: string;
  readonly twitterSiteLabel: string;
  readonly twitterSiteHint: string;
  readonly robotsLabel: string;
  readonly robotsHint: string;
  readonly structuredDataLabel: string;
  readonly structuredDataHint: string;
  readonly submit: string;
  readonly replaceWarning: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
  readonly mediaMissing: string;
  readonly badJson: string;
  /**
   * Present only on a locale whose robots body is **not** the one served (owner decision 5).
   *
   * Optional on purpose: a client component's whole props object is serialised into the RSC payload, so a sentence
   * passed with a flag that hides it would still reach every page. The server includes it where it is true and
   * leaves it out entirely everywhere else.
   */
  readonly robotsNotServedNotice?: string;
}

/** The values a locale's form starts with. Every one of them is what is stored, or empty when nothing is. */
export interface SeoSettingsFormValues {
  readonly localeCode: string;
  readonly siteName: string;
  readonly defaultMetaTitle: string;
  readonly defaultMetaDescription: string;
  readonly defaultShareMediaId: string;
  readonly twitterSite: string;
  readonly robotsTxtBody: string;
  readonly organizationStructuredData: string;
}

/** A trimmed value, or null — which the API stores as absent. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function SeoSettingsForm({
  values,
  copy,
}: {
  readonly values: SeoSettingsFormValues;
  readonly copy: SeoSettingsFormCopy;
}) {
  const router = useRouter();
  const [siteName, setSiteName] = useState(values.siteName);
  const [metaTitle, setMetaTitle] = useState(values.defaultMetaTitle);
  const [metaDescription, setMetaDescription] = useState(values.defaultMetaDescription);
  const [shareMediaId, setShareMediaId] = useState(values.defaultShareMediaId);
  const [twitterSite, setTwitterSite] = useState(values.twitterSite);
  const [robots, setRobots] = useState(values.robotsTxtBody);
  const [structuredData, setStructuredData] = useState(values.organizationStructuredData);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);

    // The one thing parsed in the browser: a document that is not JSON at all would otherwise arrive as a
    // validation failure with nothing to say about it. What is *in* the object is nobody's business here.
    let parsedStructuredData: unknown = null;
    const typed = structuredData.trim();
    if (typed !== '') {
      try {
        parsedStructuredData = JSON.parse(typed);
      } catch {
        setMessage(copy.badJson);
        return;
      }
      if (
        typeof parsedStructuredData !== 'object' ||
        parsedStructuredData === null ||
        Array.isArray(parsedStructuredData)
      ) {
        setMessage(copy.badJson);
        return;
      }
    }

    setWorking(true);
    const outcome = await send(
      '/api/seo/settings',
      {
        localeCode: values.localeCode,
        siteName: siteName.trim(),
        defaultMetaTitle: orNull(metaTitle),
        defaultMetaDescription: orNull(metaDescription),
        defaultShareMediaId: orNull(shareMediaId),
        twitterSite: orNull(twitterSite),
        // Only the ends are trimmed, and the API trims them again: the interior is the author's.
        robotsTxtBody: robots.trim() === '' ? null : robots,
        organizationStructuredData: parsedStructuredData,
      },
      'PUT',
    );
    setWorking(false);

    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    if (outcome.code === 'SEO_SETTINGS_MEDIA_MISSING') setMessage(copy.mediaMissing);
    else if (outcome.code === 'SEO_SETTINGS_NOT_ALLOWED') setMessage(copy.notAllowed);
    else if (outcome.status === 400) setMessage(copy.invalid);
    else setMessage(copy.failed);
  }

  const field = `seo-settings-${values.localeCode}`;

  return (
    <form className="mt-4" onSubmit={submit}>
      <p className={HINT_CLASS}>{copy.replaceWarning}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor={`${field}-site-name`}>
            {copy.siteNameLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${field}-site-name`}
            maxLength={SEO_SITE_NAME_MAX}
            name="siteName"
            onChange={(event) => setSiteName(event.target.value)}
            required
            value={siteName}
          />
          <p className={HINT_CLASS}>{copy.siteNameHint}</p>
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor={`${field}-twitter`}>
            {copy.twitterSiteLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${field}-twitter`}
            name="twitterSite"
            onChange={(event) => setTwitterSite(event.target.value)}
            value={twitterSite}
          />
          <p className={HINT_CLASS}>{copy.twitterSiteHint}</p>
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor={`${field}-meta-title`}>
            {copy.defaultMetaTitleLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${field}-meta-title`}
            maxLength={SEO_DEFAULT_META_TITLE_MAX}
            name="defaultMetaTitle"
            onChange={(event) => setMetaTitle(event.target.value)}
            value={metaTitle}
          />
          <p className={HINT_CLASS}>{copy.defaultMetaTitleHint}</p>
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor={`${field}-share-media`}>
            {copy.shareMediaLabel}
          </label>
          <input
            className={MONO_FIELD_CLASS}
            id={`${field}-share-media`}
            name="defaultShareMediaId"
            onChange={(event) => setShareMediaId(event.target.value)}
            value={shareMediaId}
          />
          <p className={HINT_CLASS}>{copy.shareMediaHint}</p>
        </div>
      </div>

      <div className="mt-4">
        <label className={LABEL_CLASS} htmlFor={`${field}-meta-description`}>
          {copy.defaultMetaDescriptionLabel}
        </label>
        <textarea
          className={FIELD_CLASS}
          id={`${field}-meta-description`}
          maxLength={SEO_DEFAULT_META_DESCRIPTION_MAX}
          name="defaultMetaDescription"
          onChange={(event) => setMetaDescription(event.target.value)}
          rows={2}
          value={metaDescription}
        />
        <p className={HINT_CLASS}>{copy.defaultMetaDescriptionHint}</p>
      </div>

      <div className="mt-4">
        <label className={LABEL_CLASS} htmlFor={`${field}-robots`}>
          {copy.robotsLabel}
        </label>
        <textarea
          className={MONO_FIELD_CLASS}
          id={`${field}-robots`}
          maxLength={SEO_ROBOTS_BODY_MAX}
          name="robotsTxtBody"
          onChange={(event) => setRobots(event.target.value)}
          rows={6}
          spellCheck={false}
          value={robots}
        />
        <p className={HINT_CLASS}>{copy.robotsHint}</p>
        {copy.robotsNotServedNotice === undefined ? null : (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {copy.robotsNotServedNotice}
          </p>
        )}
      </div>

      <div className="mt-4">
        <label className={LABEL_CLASS} htmlFor={`${field}-structured-data`}>
          {copy.structuredDataLabel}
        </label>
        <textarea
          className={MONO_FIELD_CLASS}
          id={`${field}-structured-data`}
          name="organizationStructuredData"
          onChange={(event) => setStructuredData(event.target.value)}
          rows={4}
          spellCheck={false}
          value={structuredData}
        />
        <p className={HINT_CLASS}>{copy.structuredDataHint}</p>
      </div>

      <Problem message={message} />

      <button className={`${BUTTON_CLASS} mt-4`} disabled={working} type="submit">
        {copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Removing one locale's settings                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoSettingsRemoveCopy {
  readonly submit: string;
  readonly confirm: string;
  readonly failed: string;
}

export function SeoSettingsRemoveForm({
  localeCode,
  copy,
}: {
  readonly localeCode: string;
  readonly copy: SeoSettingsRemoveCopy;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A delete returns a live crawler-facing document to its minimal form, so it is confirmed.
    if (!window.confirm(copy.confirm)) return;
    setMessage(null);
    setWorking(true);
    const outcome = await send('/api/seo/settings/remove', { localeCode }, 'POST');
    setWorking(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(copy.failed);
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <Problem message={message} />
      <button className={DANGER_CLASS} disabled={working} type="submit">
        {copy.submit}
      </button>
    </form>
  );
}
