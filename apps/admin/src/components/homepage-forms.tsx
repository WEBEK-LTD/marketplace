'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  HOMEPAGE_SECTION_COUNT_MAX,
  HOMEPAGE_SERVED_SECTION_TYPES,
  HOMEPAGE_TITLE_MAX,
  homepageConfigIsValid,
  type HomepageServedSectionType,
} from '@repo/contracts';

/**
 * The homepage composition controls (0093).
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No promotion, package, placement, ranking or payment field.** A featured section is the ordered ids an
 *   administrator chose (owner decision A), so there is nothing here that could carry one and nothing the
 *   contract would accept if there were.
 * - **No `banner_strip`.** It is absent from the type list below, because a banner is its image and this platform
 *   has no media origin. A section of that type that already exists is still listed and still deletable; it simply
 *   cannot be created or rendered.
 * - **No image field anywhere**, for the same reason.
 * - **No markup toggle on `rich_text`.** It is text (owner decision D).
 * - **No visibility control on the editing form.** Showing a section is its own button, so correcting a title
 *   cannot put a half-configured section in front of the public.
 * - **No optimistic state.** Typed text survives a failed request.
 *
 * **The configuration is typed as JSON and checked before it is sent.** Each section type has exactly one shape,
 * and this form validates against that shape with the same contract the API uses — so an operator sees a field
 * error rather than a conflict, and a malformed document never becomes a section the homepage silently skips.
 */

const BUTTON_CLASS = 'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-700';
const HINT_CLASS = 'mt-1 text-xs text-neutral-500';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST'): Promise<Outcome> {
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

/** One sentence for one outcome. A code the screen knows gets its own; everything else is the generic one. */
function messageFor(
  outcome: Outcome,
  copy: { readonly failed: string; readonly invalid: string } & Partial<{
    readonly keyTaken: string;
    readonly notAllowed: string;
  }>,
): string {
  if (outcome.code === 'HOMEPAGE_SECTION_KEY_TAKEN' && copy.keyTaken !== undefined) return copy.keyTaken;
  if (outcome.code === 'HOMEPAGE_SECTION_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
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

/** The example document for each type, so an operator never has to guess a shape. */
const EXAMPLES: Readonly<Record<HomepageServedSectionType, string>> = {
  hero: '{\n  "lead": "Find what you need.",\n  "ctaLabel": "Browse listings",\n  "ctaPath": "/listings"\n}',
  featured_listings: '{\n  "ids": []\n}',
  featured_categories: '{\n  "ids": []\n}',
  featured_sellers: '{\n  "ids": []\n}',
  latest_listings: '{\n  "count": 8\n}',
  blog_highlights: '{\n  "count": 3\n}',
  value_props: '{\n  "items": [\n    { "titleEn": "Safe", "bodyEn": "We check every seller." }\n  ]\n}',
  rich_text: '{\n  "bodyEn": "Plain text only."\n}',
};

/** Parses the typed document, or null when it is not JSON at all. */
function parseConfig(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating a section                                                                                */
/* ------------------------------------------------------------------------------------------------ */

export interface HomepageCreateCopy {
  readonly keyLabel: string;
  readonly keyHint: string;
  readonly typeLabel: string;
  readonly titleEnLabel: string;
  readonly titleArLabel: string;
  readonly configLabel: string;
  readonly configHint: string;
  readonly hiddenNotice: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly keyTaken: string;
  readonly notAllowed: string;
  readonly configMalformed: string;
  readonly configMismatched: string;
}

export function HomepageCreateForm({ copy }: { readonly copy: HomepageCreateCopy }) {
  const router = useRouter();
  const [sectionKey, setSectionKey] = useState('');
  const [sectionType, setSectionType] = useState<HomepageServedSectionType>('hero');
  const [titleEn, setTitleEn] = useState('');
  const [titleAr, setTitleAr] = useState('');
  const [config, setConfig] = useState(EXAMPLES.hero);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function chooseType(next: HomepageServedSectionType): void {
    setSectionType(next);
    // The example for the new type, so the document and the type are never out of step on screen.
    setConfig(EXAMPLES[next]);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = parseConfig(config);
    if (parsed === null) {
      setMessage(copy.configMalformed);
      return;
    }
    // Checked against this type's own shape with the same contract the API uses, so a mismatch is a field error
    // here rather than a section the homepage silently skips later.
    if (!homepageConfigIsValid(sectionType, parsed)) {
      setMessage(copy.configMismatched);
      return;
    }

    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/homepage/sections', {
      sectionKey: sectionKey.trim(),
      sectionType,
      ...(titleEn.trim() === '' ? {} : { titleEn: titleEn.trim() }),
      ...(titleAr.trim() === '' ? {} : { titleAr: titleAr.trim() }),
      config: parsed,
    });
    setBusy(false);
    if (outcome.status === 201) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <p className="text-sm text-neutral-600">{copy.hiddenNotice}</p>
      <div className="flex flex-wrap gap-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-create-key">
            {copy.keyLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-create-key"
            required
            value={sectionKey}
            onChange={(event) => setSectionKey(event.target.value)}
          />
          <p className={HINT_CLASS}>{copy.keyHint}</p>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-create-type">
            {copy.typeLabel}
          </label>
          <select
            className={FIELD_CLASS}
            id="homepage-create-type"
            value={sectionType}
            onChange={(event) => chooseType(event.target.value as HomepageServedSectionType)}
          >
            {HOMEPAGE_SERVED_SECTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-create-title-en">
            {copy.titleEnLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-create-title-en"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={titleEn}
            onChange={(event) => setTitleEn(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-create-title-ar">
            {copy.titleArLabel}
          </label>
          <input
            className={FIELD_CLASS}
            dir="rtl"
            id="homepage-create-title-ar"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={titleAr}
            onChange={(event) => setTitleAr(event.target.value)}
          />
        </div>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="homepage-create-config">
          {copy.configLabel}
        </label>
        <textarea
          className={`${FIELD_CLASS} font-mono`}
          id="homepage-create-config"
          rows={8}
          value={config}
          onChange={(event) => setConfig(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.configHint}</p>
      </div>
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Editing a section                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface HomepageEditCopy extends HomepageCreateCopy {
  readonly subtitleEnLabel: string;
  readonly subtitleArLabel: string;
  readonly sortOrderLabel: string;
  readonly noPublishNotice: string;
}

/** The editing form, which has **no visibility control**: showing a section is its own button. */
export function HomepageEditForm({
  sectionId,
  initial,
  copy,
}: {
  readonly sectionId: string;
  readonly initial: {
    readonly sectionKey: string;
    readonly sectionType: HomepageServedSectionType;
    readonly titleEn: string;
    readonly titleAr: string;
    readonly subtitleEn: string;
    readonly subtitleAr: string;
    readonly config: string;
    readonly sortOrder: number;
  };
  readonly copy: HomepageEditCopy;
}) {
  const router = useRouter();
  const [sectionKey, setSectionKey] = useState(initial.sectionKey);
  const [sectionType, setSectionType] = useState<HomepageServedSectionType>(initial.sectionType);
  const [titleEn, setTitleEn] = useState(initial.titleEn);
  const [titleAr, setTitleAr] = useState(initial.titleAr);
  const [subtitleEn, setSubtitleEn] = useState(initial.subtitleEn);
  const [subtitleAr, setSubtitleAr] = useState(initial.subtitleAr);
  const [config, setConfig] = useState(initial.config);
  const [sortOrder, setSortOrder] = useState(String(initial.sortOrder));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = parseConfig(config);
    if (parsed === null) {
      setMessage(copy.configMalformed);
      return;
    }
    if (!homepageConfigIsValid(sectionType, parsed)) {
      setMessage(copy.configMismatched);
      return;
    }

    setBusy(true);
    setMessage(null);
    const outcome = await send(
      '/api/homepage/sections',
      {
        sectionId,
        sectionKey: sectionKey.trim(),
        sectionType,
        // Sent as null to clear, as text to set. The form always carries all four, because a save replaces the
        // section's text and an emptied box must mean an emptied field.
        titleEn: titleEn.trim() === '' ? null : titleEn.trim(),
        titleAr: titleAr.trim() === '' ? null : titleAr.trim(),
        subtitleEn: subtitleEn.trim() === '' ? null : subtitleEn.trim(),
        subtitleAr: subtitleAr.trim() === '' ? null : subtitleAr.trim(),
        config: parsed,
        sortOrder: Number(sortOrder),
      },
      'PATCH',
    );
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <p className="text-sm text-neutral-600">{copy.noPublishNotice}</p>
      <div className="flex flex-wrap gap-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-key">
            {copy.keyLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-edit-key"
            required
            value={sectionKey}
            onChange={(event) => setSectionKey(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-type">
            {copy.typeLabel}
          </label>
          <select
            className={FIELD_CLASS}
            id="homepage-edit-type"
            value={sectionType}
            onChange={(event) => setSectionType(event.target.value as HomepageServedSectionType)}
          >
            {HOMEPAGE_SERVED_SECTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-order">
            {copy.sortOrderLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-edit-order"
            min={0}
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-title-en">
            {copy.titleEnLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-edit-title-en"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={titleEn}
            onChange={(event) => setTitleEn(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-title-ar">
            {copy.titleArLabel}
          </label>
          <input
            className={FIELD_CLASS}
            dir="rtl"
            id="homepage-edit-title-ar"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={titleAr}
            onChange={(event) => setTitleAr(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-subtitle-en">
            {copy.subtitleEnLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="homepage-edit-subtitle-en"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={subtitleEn}
            onChange={(event) => setSubtitleEn(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="homepage-edit-subtitle-ar">
            {copy.subtitleArLabel}
          </label>
          <input
            className={FIELD_CLASS}
            dir="rtl"
            id="homepage-edit-subtitle-ar"
            maxLength={HOMEPAGE_TITLE_MAX}
            value={subtitleAr}
            onChange={(event) => setSubtitleAr(event.target.value)}
          />
        </div>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="homepage-edit-config">
          {copy.configLabel}
        </label>
        <textarea
          className={`${FIELD_CLASS} font-mono`}
          id="homepage-edit-config"
          rows={10}
          value={config}
          onChange={(event) => setConfig(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.configHint}</p>
      </div>
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Showing, hiding and removing                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface HomepageStateCopy {
  /** One label, chosen on the server: the two must never both reach a browser. */
  readonly toggle: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly failed: string;
  readonly invalid: string;
}

/**
 * The visibility button and the remove button, together because they are the two things that are not an edit.
 *
 * **Only one label for the toggle reaches the browser.** The server decides whether this section is being shown or
 * hidden and passes the one word for it, because a client component's whole props object is serialised into the
 * RSC payload — so passing both would put the wrong one in the page's own source.
 */
export function HomepageSectionStateForm({
  sectionId,
  isActive,
  copy,
}: {
  readonly sectionId: string;
  readonly isActive: boolean;
  readonly copy: HomepageStateCopy;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/homepage/sections/state', { sectionId, isActive: !isActive });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  async function remove(): Promise<void> {
    if (!window.confirm(copy.removeConfirm)) return;
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/homepage/sections/remove', { sectionId });
    setBusy(false);
    if (outcome.status === 200) {
      router.push('/cms/homepage');
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className={SECONDARY_CLASS} disabled={busy} onClick={toggle} type="button">
          {copy.toggle}
        </button>
        <button className={DANGER_CLASS} disabled={busy} onClick={remove} type="button">
          {copy.remove}
        </button>
      </div>
      <Problem message={message} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Reordering                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export interface HomepageReorderCopy {
  readonly notice: string;
  readonly up: string;
  readonly down: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
}

/**
 * The whole order, sent at once.
 *
 * Moving a section is a local rearrangement until the operator saves, so a half-applied order never exists — which
 * is also why the database takes the order as one array rather than a series of moves.
 */
export function HomepageReorderForm({
  sections,
  copy,
}: {
  readonly sections: readonly { readonly id: string; readonly label: string }[];
  readonly copy: HomepageReorderCopy;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<readonly { readonly id: string; readonly label: string }[]>(sections);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function move(index: number, by: -1 | 1): void {
    const next = [...order];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    setOrder(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/homepage/sections/reorder', {
      sectionIds: order.map((entry) => entry.id),
    });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  if (order.length < 2) return null;

  return (
    <form className="mt-4" onSubmit={submit}>
      <p className="text-sm text-neutral-600">{copy.notice}</p>
      <ol className="mt-3 space-y-2">
        {order.map((entry, index) => (
          <li className="flex items-center gap-3 text-sm text-neutral-900" key={entry.id}>
            <span className="w-6 text-neutral-500">{index + 1}</span>
            <span className="flex-1">{entry.label}</span>
            <button
              aria-label={`${copy.up}: ${entry.label}`}
              className={SECONDARY_CLASS}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
              type="button"
            >
              {copy.up}
            </button>
            <button
              aria-label={`${copy.down}: ${entry.label}`}
              className={SECONDARY_CLASS}
              disabled={busy || index === order.length - 1}
              onClick={() => move(index, 1)}
              type="button"
            >
              {copy.down}
            </button>
          </li>
        ))}
      </ol>
      <button className={`${BUTTON_CLASS} mt-4`} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The count reference                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** A plain link back to the list, kept here so the detail screen needs no client component of its own. */
export function HomepageBackLink({ label }: { readonly label: string }) {
  return (
    <Link className="text-neutral-900 underline" href="/cms/homepage">
      {label}
    </Link>
  );
}

/** The largest count a counted section may ask for, shown so an operator does not have to discover it. */
export const HOMEPAGE_COUNT_CEILING = HOMEPAGE_SECTION_COUNT_MAX;
