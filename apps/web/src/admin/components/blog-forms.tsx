'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  BLOG_EXCERPT_MAX,
  BLOG_META_DESCRIPTION_MAX,
  BLOG_META_TITLE_MAX,
  BLOG_POST_STATUSES,
  BLOG_TITLE_MAX,
  type BlogPostStatus,
} from '@repo/contracts';
import { adminApiPath, adminPath } from '../paths';

/**
 * The blog authoring controls (0092).
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No byline field.** The author is the staff member who created the post, set by the database. Changing a byline
 *   is not part of this increment, so there is no control for it and nothing a browser sends could reach one.
 * - **No metadata override.** A post's `<head>` comes from `metaTitle` and `metaDescription` on its own translation,
 *   which are fields of the translation form below. There is no second source to edit.
 * - **No sitemap control.** The blog is not in the sitemap, so there is nothing here to include or exclude.
 * - **No account and no timestamp.** The API resolves the actor from the session; `updated_by` and `updated_at` are
 *   the database's.
 * - **No optimistic state.** Typed text survives a failed request.
 *
 * **The status form is separate from the details form, and that is the point.** Renaming a post cannot publish it,
 * because the request that renames it has no status field at all.
 *
 * **A translation save is a replace of that locale**, and the form says so: every field is submitted together,
 * because an emptied box empties the stored value.
 *
 * **Nothing here decides who may act.** Each form is rendered only where the server said `canManage`, and every
 * write is re-checked in the API and again in the database.
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
    readonly localeRequired: string;
    readonly notAllowed: string;
    readonly slugTaken: string;
    readonly referenceUnknown: string;
  }>,
): string {
  if (outcome.code === 'BLOG_LOCALE_REQUIRED' && copy.localeRequired !== undefined) return copy.localeRequired;
  if (outcome.code === 'BLOG_CHANGE_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
  if (outcome.code === 'BLOG_SLUG_TAKEN' && copy.slugTaken !== undefined) return copy.slugTaken;
  if (outcome.code === 'BLOG_REFERENCE_UNKNOWN' && copy.referenceUnknown !== undefined) {
    return copy.referenceUnknown;
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
/* Filters                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogFilterCopy {
  readonly statusLabel: string;
  readonly statusAny: string;
  readonly searchLabel: string;
  readonly searchHint: string;
  readonly submit: string;
  readonly clear: string;
}

/**
 * A plain GET form, so a filtered view has its own address somebody can bookmark or share.
 *
 * The status options come from the contract rather than from this file, so a state the database gains cannot be
 * missing here while being present everywhere else.
 */
export function BlogFilterForm({
  initial,
  copy,
}: {
  readonly initial: { readonly status: string | null; readonly search: string | null };
  readonly copy: BlogFilterCopy;
}) {
  return (
    <form action={adminPath('/blog')} method="get" className="mt-4 flex flex-wrap items-end gap-3">
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-filter-status">
          {copy.statusLabel}
        </label>
        <select
          className={FIELD_CLASS}
          id="blog-filter-status"
          name="status"
          defaultValue={initial.status ?? ''}
        >
          <option value="">{copy.statusAny}</option>
          {BLOG_POST_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-filter-search">
          {copy.searchLabel}
        </label>
        <input
          className={FIELD_CLASS}
          id="blog-filter-search"
          name="search"
          defaultValue={initial.search ?? ''}
          maxLength={200}
        />
        <p className={HINT_CLASS}>{copy.searchHint}</p>
      </div>
      <button className={BUTTON_CLASS} type="submit">
        {copy.submit}
      </button>
      <Link className={SECONDARY_CLASS} href={adminPath('/blog')}>
        {copy.clear}
      </Link>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating a post                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogCreateCopy {
  readonly slugLabel: string;
  readonly slugHint: string;
  readonly categoryLabel: string;
  readonly categoryNone: string;
  readonly indexableLabel: string;
  readonly submit: string;
  readonly draftNotice: string;
  readonly failed: string;
  readonly invalid: string;
  readonly slugTaken: string;
  readonly referenceUnknown: string;
}

export function BlogCreateForm({
  categories,
  copy,
}: {
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly copy: BlogCreateCopy;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isIndexable, setIndexable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('POST', '/api/blog', {
      slug: slug.trim(),
      ...(categoryId === '' ? {} : { categoryId }),
      isIndexable,
    });
    setBusy(false);
    if (outcome.status === 201) {
      // The typed text is not cleared on the way out: the navigation replaces the screen anyway, and clearing it
      // first would lose the draft if the navigation failed.
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <p className="text-sm text-ink-muted">{copy.draftNotice}</p>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-create-slug">
          {copy.slugLabel}
        </label>
        <input
          className={FIELD_CLASS}
          id="blog-create-slug"
          name="slug"
          required
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.slugHint}</p>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-create-category">
          {copy.categoryLabel}
        </label>
        <select
          className={FIELD_CLASS}
          id="blog-create-category"
          name="categoryId"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          <option value="">{copy.categoryNone}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-body">
        <input
          checked={isIndexable}
          id="blog-create-indexable"
          name="isIndexable"
          onChange={(event) => setIndexable(event.target.checked)}
          type="checkbox"
        />
        {copy.indexableLabel}
      </label>
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* A post's details                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogDetailsCopy {
  readonly slugLabel: string;
  readonly slugHint: string;
  readonly categoryLabel: string;
  readonly categoryNone: string;
  readonly indexableLabel: string;
  readonly featuredLabel: string;
  readonly featuredHint: string;
  /** The cover image, named by its library identifier (0099). */
  readonly coverLabel: string;
  readonly coverHint: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
  readonly slugTaken: string;
  readonly referenceUnknown: string;
}

/**
 * The details form, which has **no status field**.
 *
 * `categoryId` is sent as an explicit `null` when the operator chooses "none", because absent would mean "leave it
 * alone" and the category would never be removed. **The cover works the same way** (0099): an empty field is sent
 * as an explicit null and detaches the image, which is what 0092's writer has always accepted through its own
 * clear flag — this form is the first thing to send it.
 *
 * The cover is an identifier, not a picker and not a preview. The `cms-media` bucket is private and nothing here
 * is signed, so what an attached cover looks like in this console is the stored path and alt text the server
 * renders beside this form.
 */
export function BlogDetailsForm({
  postId,
  initial,
  categories,
  copy,
}: {
  readonly postId: string;
  readonly initial: {
    readonly slug: string;
    readonly categoryId: string | null;
    readonly coverMediaId: string | null;
    readonly isIndexable: boolean;
    readonly isFeatured: boolean;
  };
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly copy: BlogDetailsCopy;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(initial.slug);
  const [categoryId, setCategoryId] = useState(initial.categoryId ?? '');
  const [coverMediaId, setCoverMediaId] = useState(initial.coverMediaId ?? '');
  const [isIndexable, setIndexable] = useState(initial.isIndexable);
  const [isFeatured, setFeatured] = useState(initial.isFeatured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('PATCH', '/api/blog', {
      postId,
      slug: slug.trim(),
      // Explicitly null, never absent: null is what clears the reference.
      categoryId: categoryId === '' ? null : categoryId,
      coverMediaId: coverMediaId.trim() === '' ? null : coverMediaId.trim(),
      isIndexable,
      isFeatured,
    });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-details-slug">
          {copy.slugLabel}
        </label>
        <input
          className={FIELD_CLASS}
          id="blog-details-slug"
          name="slug"
          required
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.slugHint}</p>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-details-category">
          {copy.categoryLabel}
        </label>
        <select
          className={FIELD_CLASS}
          id="blog-details-category"
          name="categoryId"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          <option value="">{copy.categoryNone}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-details-cover">
          {copy.coverLabel}
        </label>
        <input
          autoComplete="off"
          className={FIELD_CLASS}
          id="blog-details-cover"
          name="coverMediaId"
          spellCheck={false}
          value={coverMediaId}
          onChange={(event) => setCoverMediaId(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.coverHint}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-body">
        <input
          checked={isIndexable}
          id="blog-details-indexable"
          name="isIndexable"
          onChange={(event) => setIndexable(event.target.checked)}
          type="checkbox"
        />
        {copy.indexableLabel}
      </label>
      <div>
        <label className="flex items-center gap-2 text-sm text-ink-body">
          <input
            checked={isFeatured}
            id="blog-details-featured"
            name="isFeatured"
            onChange={(event) => setFeatured(event.target.checked)}
            type="checkbox"
          />
          {copy.featuredLabel}
        </label>
        <p className={HINT_CLASS}>{copy.featuredHint}</p>
      </div>
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The lifecycle                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogStatusCopy {
  readonly statusLabel: string;
  readonly scheduledLabel: string;
  readonly scheduledHint: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly localeRequired: string;
  readonly notAllowed: string;
}

/** The only control that can publish a post, which is why it is its own form and its own request. */
export function BlogStatusForm({
  postId,
  current,
  copy,
}: {
  readonly postId: string;
  readonly current: BlogPostStatus;
  readonly copy: BlogStatusCopy;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<BlogPostStatus>(current);
  const [scheduledFor, setScheduledFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('POST', '/api/blog/status', {
      postId,
      status,
      // Sent only for a schedule: the contract refuses it on every other state, mirroring the database's own rule.
      ...(status === 'scheduled' && scheduledFor !== ''
        ? { scheduledFor: new Date(scheduledFor).toISOString() }
        : {}),
    });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="blog-status-state">
          {copy.statusLabel}
        </label>
        <select
          className={FIELD_CLASS}
          id="blog-status-state"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as BlogPostStatus)}
        >
          {BLOG_POST_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      {status !== 'scheduled' ? null : (
        <div>
          <label className={LABEL_CLASS} htmlFor="blog-status-scheduled">
            {copy.scheduledLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="blog-status-scheduled"
            name="scheduledFor"
            required
            type="datetime-local"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
          <p className={HINT_CLASS}>{copy.scheduledHint}</p>
        </div>
      )}
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One locale                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogTranslationCopy {
  readonly titleLabel: string;
  readonly excerptLabel: string;
  readonly bodyLabel: string;
  readonly metaTitleLabel: string;
  readonly metaTitleHint: string;
  readonly metaDescriptionLabel: string;
  readonly replaceNotice: string;
  readonly submit: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly failed: string;
  readonly invalid: string;
  readonly localeRequired: string;
  readonly notAllowed: string;
}

/**
 * One locale of a post, created and replaced by the same form.
 *
 * `metaTitle` and `metaDescription` live here because this is where a post's `<head>` comes from — there is no
 * override elsewhere to reconcile with, so the hint can say plainly what an empty box means.
 */
export function BlogTranslationForm({
  postId,
  localeCode,
  initial,
  copy,
}: {
  readonly postId: string;
  readonly localeCode: string;
  readonly initial: {
    readonly title: string;
    readonly excerpt: string;
    readonly body: string;
    readonly metaTitle: string;
    readonly metaDescription: string;
    readonly exists: boolean;
  };
  readonly copy: BlogTranslationCopy;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [excerpt, setExcerpt] = useState(initial.excerpt);
  const [body, setBody] = useState(initial.body);
  const [metaTitle, setMetaTitle] = useState(initial.metaTitle);
  const [metaDescription, setMetaDescription] = useState(initial.metaDescription);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('PUT', '/api/blog/translations', {
      postId,
      localeCode,
      title: title.trim(),
      body,
      // An emptied box clears the stored value, which is what the notice above the form says.
      excerpt: excerpt.trim() === '' ? null : excerpt,
      metaTitle: metaTitle.trim() === '' ? null : metaTitle.trim(),
      metaDescription: metaDescription.trim() === '' ? null : metaDescription.trim(),
    });
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
    const outcome = await send('POST', '/api/blog/translations/remove', { postId, localeCode });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={save}>
      <p className="text-sm text-ink-muted">{copy.replaceNotice}</p>
      <div>
        <label className={LABEL_CLASS} htmlFor={`blog-translation-title-${localeCode}`}>
          {copy.titleLabel}
        </label>
        <input
          className={FIELD_CLASS}
          id={`blog-translation-title-${localeCode}`}
          maxLength={BLOG_TITLE_MAX}
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor={`blog-translation-excerpt-${localeCode}`}>
          {copy.excerptLabel}
        </label>
        <textarea
          className={FIELD_CLASS}
          id={`blog-translation-excerpt-${localeCode}`}
          maxLength={BLOG_EXCERPT_MAX}
          rows={2}
          value={excerpt}
          onChange={(event) => setExcerpt(event.target.value)}
        />
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor={`blog-translation-body-${localeCode}`}>
          {copy.bodyLabel}
        </label>
        <textarea
          className={FIELD_CLASS}
          id={`blog-translation-body-${localeCode}`}
          required
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor={`blog-translation-meta-title-${localeCode}`}>
          {copy.metaTitleLabel}
        </label>
        <input
          className={FIELD_CLASS}
          id={`blog-translation-meta-title-${localeCode}`}
          maxLength={BLOG_META_TITLE_MAX}
          value={metaTitle}
          onChange={(event) => setMetaTitle(event.target.value)}
        />
        <p className={HINT_CLASS}>{copy.metaTitleHint}</p>
      </div>
      <div>
        <label className={LABEL_CLASS} htmlFor={`blog-translation-meta-description-${localeCode}`}>
          {copy.metaDescriptionLabel}
        </label>
        <textarea
          className={FIELD_CLASS}
          id={`blog-translation-meta-description-${localeCode}`}
          maxLength={BLOG_META_DESCRIPTION_MAX}
          rows={2}
          value={metaDescription}
          onChange={(event) => setMetaDescription(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
        {!initial.exists ? null : (
          <button className={DANGER_CLASS} disabled={busy} onClick={remove} type="button">
            {copy.remove}
          </button>
        )}
      </div>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* A post's tags                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogTagsCopy {
  readonly heading: string;
  readonly notice: string;
  readonly submit: string;
  readonly empty: string;
  readonly failed: string;
  readonly invalid: string;
  readonly referenceUnknown: string;
}

/** The whole set in one request, which is why these are checkboxes rather than add and remove buttons. */
export function BlogTagsForm({
  postId,
  tags,
  selected,
  copy,
}: {
  readonly postId: string;
  readonly tags: readonly { readonly id: string; readonly name: string; readonly isActive: boolean }[];
  readonly selected: readonly string[];
  readonly copy: BlogTagsCopy;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<readonly string[]>(selected);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(id: string): void {
    setChosen((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('PUT', '/api/blog/tags', { postId, tagIds: [...chosen] });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <p className="text-sm text-ink-muted">{copy.notice}</p>
      {tags.length === 0 ? (
        <p className="text-sm text-ink-muted">{copy.empty}</p>
      ) : (
        <ul className="space-y-2">
          {tags.map((tag) => (
            <li key={tag.id}>
              <label className="flex items-center gap-2 text-sm text-ink-body">
                <input
                  checked={chosen.includes(tag.id)}
                  onChange={() => toggle(tag.id)}
                  type="checkbox"
                  value={tag.id}
                />
                {tag.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <button className={BUTTON_CLASS} disabled={busy} type="submit">
        {copy.submit}
      </button>
      <Problem message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The taxonomy                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogTaxonomyCopy {
  readonly slugLabel: string;
  readonly nameEnLabel: string;
  readonly nameArLabel: string;
  readonly nameArHint: string;
  readonly sortOrderLabel: string;
  readonly activeLabel: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly slugTaken: string;
  readonly notAllowed: string;
}

/**
 * One category or tag, created or replaced.
 *
 * When replacing, the fields the operator did not touch are **sent as they came back from the server** rather than
 * omitted — the request is a partial update, so sending the current value is how an untouched field stays untouched
 * while a cleared one clears. `sortOrder` and `isActive` are only sent when this form owns them, which keeps the
 * database's "null means leave it alone" reading intact for everything else.
 */
export function BlogTaxonomyForm({
  kind,
  entryId,
  initial,
  copy,
}: {
  readonly kind: 'category' | 'tag';
  readonly entryId: string | null;
  readonly initial: {
    readonly slug: string;
    readonly nameEn: string;
    readonly nameAr: string;
    readonly sortOrder: number;
    readonly isActive: boolean;
  };
  readonly copy: BlogTaxonomyCopy;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(initial.slug);
  const [nameEn, setNameEn] = useState(initial.nameEn);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [sortOrder, setSortOrder] = useState(String(initial.sortOrder));
  const [isActive, setActive] = useState(initial.isActive);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const prefix = `blog-${kind}-${entryId ?? 'new'}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('POST', '/api/blog/taxonomy', {
      kind,
      ...(entryId === null ? {} : { entryId }),
      slug: slug.trim(),
      nameEn: nameEn.trim(),
      // An empty string clears an optional Arabic name; the contract accepts it for exactly that.
      nameAr: nameAr.trim(),
      ...(kind === 'category' ? { sortOrder: Number(sortOrder) } : {}),
      isActive,
    });
    setBusy(false);
    if (outcome.status === (entryId === null ? 201 : 200)) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-3 space-y-3" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={LABEL_CLASS} htmlFor={`${prefix}-slug`}>
            {copy.slugLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${prefix}-slug`}
            required
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor={`${prefix}-name-en`}>
            {copy.nameEnLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${prefix}-name-en`}
            required
            value={nameEn}
            onChange={(event) => setNameEn(event.target.value)}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor={`${prefix}-name-ar`}>
            {copy.nameArLabel}
          </label>
          <input
            className={FIELD_CLASS}
            dir="rtl"
            id={`${prefix}-name-ar`}
            value={nameAr}
            onChange={(event) => setNameAr(event.target.value)}
          />
          <p className={HINT_CLASS}>{copy.nameArHint}</p>
        </div>
        {kind !== 'category' ? null : (
          <div>
            <label className={LABEL_CLASS} htmlFor={`${prefix}-sort-order`}>
              {copy.sortOrderLabel}
            </label>
            <input
              className={FIELD_CLASS}
              id={`${prefix}-sort-order`}
              min={0}
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-body">
          <input
            checked={isActive}
            id={`${prefix}-active`}
            onChange={(event) => setActive(event.target.checked)}
            type="checkbox"
          />
          {copy.activeLabel}
        </label>
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
      </div>
      <Problem message={message} />
    </form>
  );
}
