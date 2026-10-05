'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_LISTING_TYPES,
  CATEGORY_META_DESCRIPTION_MAX,
  CATEGORY_META_TITLE_MAX,
  CATEGORY_NAME_MAX,
  CATEGORY_SORT_ORDER_MAX,
  type CategoryListingType,
} from '@repo/contracts';

/**
 * The category controls.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No slug field anywhere but the create form.** A category's slug is its public address and there is no slug
 *   history to redirect from, so a rename is not a control that was left out — the route, the contract and the
 *   database function all lack it.
 * - **No active state on the settings form.** Showing or hiding is the one edit a visitor notices, so it is its
 *   own request against its own route; a colleague fixing an ordering cannot publish a category by accident.
 * - **No depth field.** The tree derives depth from the parent and refuses a fourth level.
 * - **No delete control.** Listings, commission rules, tax rules, coupons and promotion packages all reference a
 *   category with `ON DELETE RESTRICT`; hiding is the operation that exists.
 * - **No account and no timestamp.** Both are the database's.
 * - **No optimistic state.** Typed text survives a failed request, because a colleague who lost a description has
 *   lost more than the request.
 *
 * **Refusals are shown by code**, because four are expected and each means something different: the tree refused
 * the move, the address is taken, the category has to be named first, or a value is too long.
 */

const BUTTON_CLASS = 'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-700';
const HINT_CLASS = 'mt-1 text-xs text-neutral-500';

export interface CategoryParentOption {
  readonly categoryId: string;
  readonly label: string;
}

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

/** Every label a form needs, resolved on the server so no translation lookup happens in a client bundle. */
export interface CategoryLabels {
  readonly working: string;
  readonly failed: string;
  readonly slugTaken: string;
  readonly treeNotAllowed: string;
  readonly valueNotAllowed: string;
  readonly nameRequired: string;
}

async function send(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
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
function messageFor(outcome: Outcome, labels: CategoryLabels, success: string): string {
  if (outcome.status === 200 || outcome.status === 201) return success;
  if (outcome.code === 'CATEGORY_SLUG_TAKEN') return labels.slugTaken;
  if (outcome.code === 'CATEGORY_TREE_NOT_ALLOWED') return labels.treeNotAllowed;
  if (outcome.code === 'CATEGORY_NAME_REQUIRED') return labels.nameRequired;
  if (outcome.code === 'CATEGORY_VALUE_NOT_ALLOWED') return labels.valueNotAllowed;
  return labels.failed;
}

function Note({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 text-sm text-neutral-700" role="status">
      {message}
    </p>
  );
}

/** The listing-type selector, shared by the create and settings forms. */
function ListingTypeField({
  value,
  onChange,
  labels,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly labels: { listingType: string; anyListingType: string; product: string; service: string };
}) {
  return (
    <label className="block">
      <span className={LABEL_CLASS}>{labels.listingType}</span>
      <select className={FIELD_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{labels.anyListingType}</option>
        {CATEGORY_LISTING_TYPES.map((type: CategoryListingType) => (
          <option key={type} value={type}>
            {type === 'product' ? labels.product : labels.service}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Create                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export function CategoryCreateForm({
  parents,
  labels,
}: {
  readonly parents: readonly CategoryParentOption[];
  readonly labels: CategoryLabels & {
    slug: string;
    slugHint: string;
    parent: string;
    noParent: string;
    listingType: string;
    anyListingType: string;
    product: string;
    service: string;
    sortOrder: string;
    submit: string;
    created: string;
  };
}) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [parentId, setParentId] = useState('');
  const [listingTypeCode, setListingTypeCode] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/categories', {
      slug: slug.trim(),
      ...(parentId === '' ? {} : { parentId }),
      ...(listingTypeCode === '' ? {} : { listingTypeCode }),
      ...(sortOrder === '' ? {} : { sortOrder: Number(sortOrder) }),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.created));
    if (outcome.status === 201) {
      // The slug is cleared because it can never be reused; the rest is kept, since a run of sibling
      // categories is usually created with the same parent and surface.
      setSlug('');
      router.refresh();
    }
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.slug}</span>
        <input
          className={FIELD_CLASS}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          maxLength={80}
          required
        />
        <span className={HINT_CLASS}>{labels.slugHint}</span>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.parent}</span>
        <select className={FIELD_CLASS} value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">{labels.noParent}</option>
          {parents.map((parent) => (
            <option key={parent.categoryId} value={parent.categoryId}>
              {parent.label}
            </option>
          ))}
        </select>
      </label>

      <ListingTypeField value={listingTypeCode} onChange={setListingTypeCode} labels={labels} />

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={CATEGORY_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Settings                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export function CategorySettingsForm({
  categoryId,
  parentId: initialParentId,
  listingTypeCode: initialListingType,
  sortOrder: initialSortOrder,
  parents,
  labels,
}: {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly listingTypeCode: string | null;
  readonly sortOrder: number;
  readonly parents: readonly CategoryParentOption[];
  readonly labels: CategoryLabels & {
    parent: string;
    noParent: string;
    listingType: string;
    anyListingType: string;
    product: string;
    service: string;
    sortOrder: string;
    submit: string;
    saved: string;
  };
}) {
  const router = useRouter();
  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [listingTypeCode, setListingTypeCode] = useState(initialListingType ?? '');
  const [sortOrder, setSortOrder] = useState(String(initialSortOrder));
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    // `setParent` is always true here: this form shows the current parent, so submitting it is a statement about
    // the parent either way — including "no parent", which is a move to the root rather than an omission.
    const outcome = await send('PATCH', '/api/categories', {
      categoryId,
      setParent: true,
      parentId: parentId === '' ? null : parentId,
      ...(listingTypeCode === '' ? {} : { listingTypeCode }),
      ...(sortOrder === '' ? {} : { sortOrder: Number(sortOrder) }),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.parent}</span>
        <select className={FIELD_CLASS} value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">{labels.noParent}</option>
          {parents.map((parent) => (
            <option key={parent.categoryId} value={parent.categoryId}>
              {parent.label}
            </option>
          ))}
        </select>
      </label>

      <ListingTypeField value={listingTypeCode} onChange={setListingTypeCode} labels={labels} />

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={CATEGORY_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Showing and hiding                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One button, and a second press to mean it.
 *
 * This is the only control here a visitor notices, so it asks twice rather than acting on one click.
 */
export function CategoryStateForm({
  categoryId,
  isActive,
  labels,
}: {
  readonly categoryId: string;
  readonly isActive: boolean;
  readonly labels: CategoryLabels & { show: string; hide: string; confirm: string; saved: string };
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!armed) {
      setArmed(true);
      return;
    }
    setWorking(true);
    setMessage(null);
    const outcome = await send('PUT', '/api/categories/state', { categoryId, isActive: !isActive });
    setWorking(false);
    setArmed(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <button className={isActive ? DANGER_CLASS : BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : armed ? labels.confirm : isActive ? labels.hide : labels.show}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Translations                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface CategoryTranslationDraft {
  readonly localeCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
}

/**
 * One locale at a time, with the locale chosen by a switcher.
 *
 * Switching locale loads what is stored for it, so an author never overwrites Arabic with English text by
 * forgetting which one they were editing. A field cleared to blank clears the stored value, which is why an empty
 * string is sent rather than omitted — the writer stores a blank as null.
 */
export function CategoryTranslationForm({
  categoryId,
  translations,
  labels,
}: {
  readonly categoryId: string;
  readonly translations: readonly CategoryTranslationDraft[];
  readonly labels: CategoryLabels & {
    locale: string;
    name: string;
    description: string;
    metaTitle: string;
    metaDescription: string;
    clearHint: string;
    submit: string;
    remove: string;
    confirm: string;
    saved: string;
    removed: string;
  };
}) {
  const router = useRouter();
  const locales = ['en', 'ar'] as const;
  const [localeCode, setLocaleCode] = useState<string>('en');
  const existing = translations.find((translation) => translation.localeCode === 'en');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [metaTitle, setMetaTitle] = useState(existing?.metaTitle ?? '');
  const [metaDescription, setMetaDescription] = useState(existing?.metaDescription ?? '');
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  function switchLocale(next: string): void {
    setLocaleCode(next);
    const stored = translations.find((translation) => translation.localeCode === next);
    setName(stored?.name ?? '');
    setDescription(stored?.description ?? '');
    setMetaTitle(stored?.metaTitle ?? '');
    setMetaDescription(stored?.metaDescription ?? '');
    setArmed(false);
    setMessage(null);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PUT', '/api/categories/translations', {
      categoryId,
      localeCode,
      name,
      description,
      metaTitle,
      metaDescription,
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  async function remove(): Promise<void> {
    if (!armed) {
      setArmed(true);
      return;
    }
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/categories/translations/remove', { categoryId, localeCode });
    setWorking(false);
    setArmed(false);
    setMessage(messageFor(outcome, labels, labels.removed));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={save}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.locale}</span>
        <select className={FIELD_CLASS} value={localeCode} onChange={(event) => switchLocale(event.target.value)}>
          {locales.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.name}</span>
        <input
          className={FIELD_CLASS}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={CATEGORY_NAME_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.description}</span>
        <textarea
          className={FIELD_CLASS}
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={CATEGORY_DESCRIPTION_MAX}
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.metaTitle}</span>
        <input
          className={FIELD_CLASS}
          value={metaTitle}
          onChange={(event) => setMetaTitle(event.target.value)}
          maxLength={CATEGORY_META_TITLE_MAX}
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.metaDescription}</span>
        <textarea
          className={FIELD_CLASS}
          rows={2}
          value={metaDescription}
          onChange={(event) => setMetaDescription(event.target.value)}
          maxLength={CATEGORY_META_DESCRIPTION_MAX}
        />
      </label>

      <p className={HINT_CLASS}>{labels.clearHint}</p>

      <div className="flex gap-3">
        <button className={BUTTON_CLASS} type="submit" disabled={working}>
          {working ? labels.working : labels.submit}
        </button>
        <button className={DANGER_CLASS} type="button" onClick={remove} disabled={working}>
          {armed ? labels.confirm : labels.remove}
        </button>
      </div>
      <Note message={message} />
    </form>
  );
}
