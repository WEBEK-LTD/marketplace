'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  NAVIGATION_LABEL_MAX,
  NAVIGATION_MENU_KEYS,
  NAVIGATION_TARGET_KINDS,
  NavigationTargetInputSchema,
  type NavigationTargetKind,
} from '@repo/contracts';
import { adminApiPath, adminPath } from '../paths';

/**
 * The navigation controls (0094).
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No promotion, package, placement, ranking or payment field.** A menu entry is a label and a target.
 * - **No image field.** `navigation_items` has no media column and this platform has no media origin.
 * - **No free-text URL.** A target is a page, a post, a category or a *relative* path; the same contract the API
 *   uses refuses anything that could leave the site, so an operator sees a field error rather than a conflict.
 * - **No visibility control on an editing form.** Showing a menu or an entry is its own button, so correcting a
 *   label cannot put a half-built menu in front of the public.
 * - **No third level.** The parent field offers the top-level entries of this menu only, because 0030 allows one
 *   level of nesting and a deeper arrangement would simply be refused.
 * - **No optimistic state.** Typed text survives a failed request.
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
  path: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' = 'POST',
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
    readonly keyTaken: string;
    readonly notAllowed: string;
    readonly unknownReference: string;
  }>,
): string {
  if (outcome.code === 'NAVIGATION_MENU_KEY_TAKEN' && copy.keyTaken !== undefined) return copy.keyTaken;
  if (outcome.code === 'NAVIGATION_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
  if (outcome.code === 'NAVIGATION_REFERENCE_UNKNOWN' && copy.unknownReference !== undefined) {
    return copy.unknownReference;
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

/** The copy a target picker needs. One shape, used by both the create and the edit form. */
export interface NavigationTargetCopy {
  readonly kindLabel: string;
  readonly kindHint: string;
  readonly pageIdLabel: string;
  readonly blogPostIdLabel: string;
  readonly categoryIdLabel: string;
  readonly pathLabel: string;
  readonly pathHint: string;
  readonly kindNames: Readonly<Record<NavigationTargetKind, string>>;
}

/** The fields of one target, as a form holds them before they become one value. */
interface TargetDraft {
  kind: NavigationTargetKind;
  pageId: string;
  blogPostId: string;
  categoryId: string;
  path: string;
}

const EMPTY_TARGET: TargetDraft = { kind: 'path', pageId: '', blogPostId: '', categoryId: '', path: '' };

/**
 * The draft as the one value 0030 stores, or null when it is not one yet.
 *
 * Checked with the API's own schema, so a target that would be refused at the boundary is refused here first.
 */
function targetOf(draft: TargetDraft): Record<string, unknown> | null {
  const candidate =
    draft.kind === 'page'
      ? { kind: draft.kind, pageId: draft.pageId.trim() }
      : draft.kind === 'blog_post'
        ? { kind: draft.kind, blogPostId: draft.blogPostId.trim() }
        : draft.kind === 'category'
          ? { kind: draft.kind, categoryId: draft.categoryId.trim() }
          : { kind: draft.kind, path: draft.path.trim() };
  return NavigationTargetInputSchema.safeParse(candidate).success ? candidate : null;
}

function TargetFields({
  draft,
  set,
  copy,
}: {
  readonly draft: TargetDraft;
  readonly set: (next: TargetDraft) => void;
  readonly copy: NavigationTargetCopy;
}) {
  return (
    <>
      <label className={LABEL_CLASS}>
        {copy.kindLabel}
        <select
          className={FIELD_CLASS}
          name="targetKind"
          onChange={(event) => set({ ...draft, kind: event.target.value as NavigationTargetKind })}
          value={draft.kind}
        >
          {NAVIGATION_TARGET_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {copy.kindNames[kind]}
            </option>
          ))}
        </select>
        <span className={HINT_CLASS}>{copy.kindHint}</span>
      </label>

      {/* Only the field the chosen kind owns is rendered, because only one of them may be filled. */}
      {draft.kind === 'page' ? (
        <label className={LABEL_CLASS}>
          {copy.pageIdLabel}
          <input
            className={FIELD_CLASS}
            name="pageId"
            onChange={(event) => set({ ...draft, pageId: event.target.value })}
            value={draft.pageId}
          />
        </label>
      ) : null}
      {draft.kind === 'blog_post' ? (
        <label className={LABEL_CLASS}>
          {copy.blogPostIdLabel}
          <input
            className={FIELD_CLASS}
            name="blogPostId"
            onChange={(event) => set({ ...draft, blogPostId: event.target.value })}
            value={draft.blogPostId}
          />
        </label>
      ) : null}
      {draft.kind === 'category' ? (
        <label className={LABEL_CLASS}>
          {copy.categoryIdLabel}
          <input
            className={FIELD_CLASS}
            name="categoryId"
            onChange={(event) => set({ ...draft, categoryId: event.target.value })}
            value={draft.categoryId}
          />
        </label>
      ) : null}
      {draft.kind === 'path' ? (
        <label className={LABEL_CLASS}>
          {copy.pathLabel}
          <input
            className={FIELD_CLASS}
            name="path"
            onChange={(event) => set({ ...draft, path: event.target.value })}
            value={draft.path}
          />
          <span className={HINT_CLASS}>{copy.pathHint}</span>
        </label>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating a menu                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationMenuCreateCopy {
  readonly keyLabel: string;
  readonly keyHint: string;
  readonly labelEnLabel: string;
  readonly labelArLabel: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly keyTaken: string;
  readonly notAllowed: string;
}

export function NavigationMenuCreateForm({ copy }: { readonly copy: NavigationMenuCreateCopy }) {
  const router = useRouter();
  const [values, setValues] = useState({ menuKey: 'header', labelEn: '', labelAr: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function set(field: keyof typeof values, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/navigation/menus', {
      menuKey: values.menuKey.trim(),
      labelEn: values.labelEn.trim(),
      ...(values.labelAr.trim() === '' ? {} : { labelAr: values.labelAr.trim() }),
    });
    setBusy(false);
    if (outcome.status === 201) {
      setValues({ menuKey: 'header', labelEn: '', labelAr: '' });
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className={LABEL_CLASS}>
        {copy.keyLabel}
        {/* The three placements the site renders, offered as a list rather than typed: a menu under any other key
            is legal and simply unplaced, which is a thing to do on purpose and not by mistyping. */}
        <input
          className={FIELD_CLASS}
          list="navigation-menu-keys"
          name="menuKey"
          onChange={(event) => set('menuKey', event.target.value)}
          required
          value={values.menuKey}
        />
        <datalist id="navigation-menu-keys">
          {NAVIGATION_MENU_KEYS.map((key) => (
            <option key={key} value={key} />
          ))}
        </datalist>
        <span className={HINT_CLASS}>{copy.keyHint}</span>
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelEn"
          onChange={(event) => set('labelEn', event.target.value)}
          required
          value={values.labelEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelAr"
          onChange={(event) => set('labelAr', event.target.value)}
          value={values.labelAr}
        />
      </label>

      <div className="sm:col-span-2">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Changing a menu                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationMenuEditCopy extends NavigationMenuCreateCopy {
  readonly clearArabic: string;
}

export function NavigationMenuEditForm({
  menuId,
  menuKey,
  labelEn,
  labelAr,
  copy,
}: {
  readonly menuId: string;
  readonly menuKey: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly copy: NavigationMenuEditCopy;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ menuKey, labelEn, labelAr: labelAr ?? '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function set(field: keyof typeof values, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send(
      '/api/navigation/menus',
      {
        menuId,
        menuKey: values.menuKey.trim(),
        labelEn: values.labelEn.trim(),
        // Sent as null to clear it, which is a different thing from leaving it out.
        labelAr: values.labelAr.trim() === '' ? null : values.labelAr.trim(),
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
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className={LABEL_CLASS}>
        {copy.keyLabel}
        <input
          className={FIELD_CLASS}
          list="navigation-menu-keys-edit"
          name="menuKey"
          onChange={(event) => set('menuKey', event.target.value)}
          required
          value={values.menuKey}
        />
        <datalist id="navigation-menu-keys-edit">
          {NAVIGATION_MENU_KEYS.map((key) => (
            <option key={key} value={key} />
          ))}
        </datalist>
        <span className={HINT_CLASS}>{copy.keyHint}</span>
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelEn"
          onChange={(event) => set('labelEn', event.target.value)}
          required
          value={values.labelEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelAr"
          onChange={(event) => set('labelAr', event.target.value)}
          value={values.labelAr}
        />
        <span className={HINT_CLASS}>{copy.clearArabic}</span>
      </label>

      <div className="sm:col-span-2">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Showing, hiding and removing a menu                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationStateCopy {
  readonly toggle: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly failed: string;
  readonly invalid: string;
}

export function NavigationMenuStateForm({
  menuId,
  isActive,
  copy,
}: {
  readonly menuId: string;
  readonly isActive: boolean;
  readonly copy: NavigationStateCopy;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/navigation/menus/state', { menuId, isActive: !isActive });
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
    const outcome = await send('/api/navigation/menus/remove', { menuId });
    setBusy(false);
    if (outcome.status === 200) {
      router.push(adminPath('/cms/navigation'));
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
/* Creating an entry                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationItemCreateCopy extends NavigationTargetCopy {
  readonly labelEnLabel: string;
  readonly labelArLabel: string;
  readonly parentLabel: string;
  readonly parentNone: string;
  readonly parentHint: string;
  readonly newTabLabel: string;
  readonly sortOrderLabel: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
  readonly unknownReference: string;
  readonly targetInvalid: string;
}

/** The headings an entry may sit under: the top-level entries of this menu, and nothing else. */
export interface NavigationParentOption {
  readonly id: string;
  readonly label: string;
}

export function NavigationItemCreateForm({
  menuId,
  parents,
  copy,
}: {
  readonly menuId: string;
  readonly parents: readonly NavigationParentOption[];
  readonly copy: NavigationItemCreateCopy;
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    labelEn: '',
    labelAr: '',
    parentId: '',
    opensInNewTab: false,
    sortOrder: '',
  });
  const [target, setTarget] = useState<TargetDraft>(EMPTY_TARGET);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const resolved = targetOf(target);
    if (resolved === null) {
      // Checked with the API's own schema before anything is sent, so an operator sees the field that is wrong.
      setMessage(copy.targetInvalid);
      return;
    }

    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/navigation/items', {
      menuId,
      labelEn: values.labelEn.trim(),
      ...(values.labelAr.trim() === '' ? {} : { labelAr: values.labelAr.trim() }),
      ...resolved,
      ...(values.parentId === '' ? {} : { parentId: values.parentId }),
      opensInNewTab: values.opensInNewTab,
      ...(values.sortOrder.trim() === '' ? {} : { sortOrder: Number(values.sortOrder) }),
    });
    setBusy(false);
    if (outcome.status === 201) {
      setValues({ labelEn: '', labelAr: '', parentId: '', opensInNewTab: false, sortOrder: '' });
      setTarget(EMPTY_TARGET);
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className={LABEL_CLASS}>
        {copy.labelEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelEn"
          onChange={(event) => setValues({ ...values, labelEn: event.target.value })}
          required
          value={values.labelEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelAr"
          onChange={(event) => setValues({ ...values, labelAr: event.target.value })}
          value={values.labelAr}
        />
      </label>

      <TargetFields copy={copy} draft={target} set={setTarget} />

      <label className={LABEL_CLASS}>
        {copy.parentLabel}
        <select
          className={FIELD_CLASS}
          name="parentId"
          onChange={(event) => setValues({ ...values, parentId: event.target.value })}
          value={values.parentId}
        >
          <option value="">{copy.parentNone}</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.label}
            </option>
          ))}
        </select>
        <span className={HINT_CLASS}>{copy.parentHint}</span>
      </label>

      <label className={LABEL_CLASS}>
        {copy.sortOrderLabel}
        <input
          className={FIELD_CLASS}
          inputMode="numeric"
          name="sortOrder"
          onChange={(event) => setValues({ ...values, sortOrder: event.target.value })}
          value={values.sortOrder}
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-ink-body">
        <input
          checked={values.opensInNewTab}
          name="opensInNewTab"
          onChange={(event) => setValues({ ...values, opensInNewTab: event.target.checked })}
          type="checkbox"
        />
        {copy.newTabLabel}
      </label>

      <div className="sm:col-span-2">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One entry's own controls                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationItemRowCopy extends NavigationTargetCopy {
  readonly labelEnLabel: string;
  readonly labelArLabel: string;
  readonly newTabLabel: string;
  readonly sortOrderLabel: string;
  readonly save: string;
  /**
   * Present only for an entry that actually sits under a heading.
   *
   * Not a boolean, and that is the point: a client component's whole props object is serialised into the RSC
   * payload, so a label passed for a button this row does not render would still appear in the page's own source.
   * The server decides by leaving the word out entirely.
   */
  readonly promote?: string;
  readonly toggle: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
  readonly unknownReference: string;
  readonly targetInvalid: string;
}

export function NavigationItemControls({
  itemId,
  isActive,
  labelEn,
  labelAr,
  targetKind,
  pageId,
  blogPostId,
  categoryId,
  path,
  opensInNewTab,
  sortOrder,
  copy,
}: {
  readonly itemId: string;
  readonly isActive: boolean;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly targetKind: NavigationTargetKind;
  readonly pageId: string | null;
  readonly blogPostId: string | null;
  readonly categoryId: string | null;
  readonly path: string | null;
  readonly opensInNewTab: boolean;
  readonly sortOrder: number;
  readonly copy: NavigationItemRowCopy;
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    labelEn,
    labelAr: labelAr ?? '',
    opensInNewTab,
    sortOrder: String(sortOrder),
  });
  const [target, setTarget] = useState<TargetDraft>({
    kind: targetKind,
    pageId: pageId ?? '',
    blogPostId: blogPostId ?? '',
    categoryId: categoryId ?? '',
    path: path ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<Outcome>, after: 'refresh' = 'refresh'): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await action();
    setBusy(false);
    if (outcome.status === 200) {
      if (after === 'refresh') router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const resolved = targetOf(target);
    if (resolved === null) {
      setMessage(copy.targetInvalid);
      return;
    }
    await run(async () =>
      send(
        '/api/navigation/items',
        {
          itemId,
          labelEn: values.labelEn.trim(),
          labelAr: values.labelAr.trim() === '' ? null : values.labelAr.trim(),
          ...resolved,
          opensInNewTab: values.opensInNewTab,
          ...(values.sortOrder.trim() === '' ? {} : { sortOrder: Number(values.sortOrder) }),
        },
        'PATCH',
      ),
    );
  }

  async function remove(): Promise<void> {
    if (!window.confirm(copy.removeConfirm)) return;
    await run(async () => send('/api/navigation/items/remove', { itemId }));
  }

  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
      <label className={LABEL_CLASS}>
        {copy.labelEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelEn"
          onChange={(event) => setValues({ ...values, labelEn: event.target.value })}
          required
          value={values.labelEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.labelArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={NAVIGATION_LABEL_MAX}
          name="labelAr"
          onChange={(event) => setValues({ ...values, labelAr: event.target.value })}
          value={values.labelAr}
        />
      </label>

      <TargetFields copy={copy} draft={target} set={setTarget} />

      <label className={LABEL_CLASS}>
        {copy.sortOrderLabel}
        <input
          className={FIELD_CLASS}
          inputMode="numeric"
          name="sortOrder"
          onChange={(event) => setValues({ ...values, sortOrder: event.target.value })}
          value={values.sortOrder}
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-ink-body">
        <input
          checked={values.opensInNewTab}
          name="opensInNewTab"
          onChange={(event) => setValues({ ...values, opensInNewTab: event.target.checked })}
          type="checkbox"
        />
        {copy.newTabLabel}
      </label>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.save}
        </button>
        <button
          className={SECONDARY_CLASS}
          disabled={busy}
          onClick={() => void run(async () => send('/api/navigation/items/state', { itemId, isActive: !isActive }))}
          type="button"
        >
          {copy.toggle}
        </button>
        {/* Only an entry that actually sits under a heading can be promoted. The server says so by sending the
            word for it, because a props object reaches the browser whole and a label passed for a button that is
            never rendered would still be in the page's source. */}
        {copy.promote === undefined ? null : (
          <button
            className={SECONDARY_CLASS}
            disabled={busy}
            onClick={() => void run(async () => send('/api/navigation/items/promote', { itemId }))}
            type="button"
          >
            {copy.promote}
          </button>
        )}
        <button className={DANGER_CLASS} disabled={busy} onClick={remove} type="button">
          {copy.remove}
        </button>
      </div>
      <div className="sm:col-span-2">
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Reordering                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export interface NavigationReorderCopy {
  readonly heading: string;
  readonly hint: string;
  readonly up: string;
  readonly down: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
}

export function NavigationReorderForm({
  menuId,
  items,
  copy,
}: {
  readonly menuId: string;
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly copy: NavigationReorderCopy;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<readonly { id: string; label: string }[]>(
    items.map((item) => ({ id: item.id, label: item.label })),
  );
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

  async function submit(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/navigation/items/reorder', {
      menuId,
      itemIds: order.map((item) => item.id),
    });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <div className="mt-6">
      <p className="text-sm font-medium text-ink-body">{copy.heading}</p>
      <p className={HINT_CLASS}>{copy.hint}</p>
      <ol className="mt-3 space-y-2">
        {order.map((item, index) => (
          <li className="flex items-center gap-3 text-sm text-ink-strong" key={item.id}>
            <span className="flex-1">{item.label}</span>
            <button
              aria-label={`${copy.up}: ${item.label}`}
              className={SECONDARY_CLASS}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
              type="button"
            >
              {copy.up}
            </button>
            <button
              aria-label={`${copy.down}: ${item.label}`}
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
      <button className={`${BUTTON_CLASS} mt-3`} disabled={busy} onClick={submit} type="button">
        {copy.submit}
      </button>
      <Problem message={message} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export function NavigationBackLink({ label }: { readonly label: string }) {
  return (
    <Link className="text-ink-strong underline" href={adminPath('/cms/navigation')}>
      {label}
    </Link>
  );
}
