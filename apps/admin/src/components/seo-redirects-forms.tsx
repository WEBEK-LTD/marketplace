'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  REDIRECT_NOTE_MAX,
  REDIRECT_PATH_MAX,
  REDIRECT_STATUS_CODES,
  type RedirectStatusCode,
} from '@repo/contracts';

/**
 * The redirect-map controls.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No account, and no way to name one.** The API resolves the caller from their own session; `created_by` is
 *   written by the database from that account, so there is no field here that could carry somebody else's.
 * - **No timestamp.** `created_at` and `updated_at` are the database's.
 * - **No state on the edit form, and no addresses on the state form.** The two are separate requests against
 *   separate routes, so correcting a typo in a destination cannot switch a redirect on — and the contract drops
 *   such a field rather than relying on this file to omit it.
 * - **No priority, no pattern, no wildcard and no bulk import.** None of those exists on this map, and a disabled
 *   control for one would be a promise nobody has made.
 * - **No optimistic state.** Typed text survives a failed request.
 *
 * **Refusals are shown in the server's words, mapped by code.** Two are expected and they mean different things: the
 * address is already somebody else's redirect, or the entry itself is not a legal one.
 *
 * **Removal asks twice, and the screen offers switching off first.** Switching off is reversible and removal is not,
 * so the reversible action is the prominent one.
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
function messageFor(
  outcome: Outcome,
  copy: { readonly failed: string; readonly invalid: string } & Partial<{
    readonly pathTaken: string;
    readonly notAllowed: string;
  }>,
): string {
  if (outcome.code === 'SEO_REDIRECT_PATH_TAKEN' && copy.pathTaken !== undefined) return copy.pathTaken;
  if (outcome.code === 'SEO_REDIRECT_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
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
/* Search                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoRedirectSearchCopy {
  readonly searchLabel: string;
  readonly searchHint: string;
  readonly stateLabel: string;
  readonly stateAny: string;
  readonly stateActive: string;
  readonly stateInactive: string;
  readonly submit: string;
  readonly clear: string;
}

/**
 * The search and state filter, as a plain `GET` form.
 *
 * No JavaScript decides anything here: submitting navigates, so a filtered list has a real URL that can be
 * bookmarked and shared, and the back button does the obvious thing. The one piece of client state is the typed
 * text, which is what a form field is.
 */
export function SeoRedirectSearchForm({
  initial,
  copy,
}: {
  readonly initial: { readonly search: string | null; readonly active: string | null };
  readonly copy: SeoRedirectSearchCopy;
}) {
  const [search, setSearch] = useState(initial.search ?? '');
  const [active, setActive] = useState(initial.active ?? '');

  return (
    <form className="mt-4 flex flex-wrap items-end gap-3" method="get" action="/seo/redirects">
      <div className="min-w-64 flex-1">
        <label className={LABEL_CLASS} htmlFor="redirect-search">
          {copy.searchLabel}
        </label>
        <input
          id="redirect-search"
          className={FIELD_CLASS}
          name="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={REDIRECT_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.searchHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-state">
          {copy.stateLabel}
        </label>
        <select
          id="redirect-state"
          className={FIELD_CLASS}
          name="active"
          value={active}
          onChange={(event) => setActive(event.target.value)}
        >
          <option value="">{copy.stateAny}</option>
          <option value="true">{copy.stateActive}</option>
          <option value="false">{copy.stateInactive}</option>
        </select>
      </div>

      <button className={BUTTON_CLASS} type="submit">
        {copy.submit}
      </button>
      {search === '' && active === '' ? null : (
        // `Link` rather than an anchor: this address is a route of this app, and the client router owns navigation
        // between its own pages.
        <Link className={SECONDARY_CLASS} href="/seo/redirects">
          {copy.clear}
        </Link>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Create                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoRedirectCreateCopy {
  readonly fromLabel: string;
  readonly fromHint: string;
  readonly toLabel: string;
  readonly toHint: string;
  readonly statusLabel: string;
  readonly statusHint: string;
  readonly noteLabel: string;
  readonly activeLabel: string;
  readonly activeHint: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly pathTaken: string;
  readonly notAllowed: string;
  readonly invalid: string;
}

export function SeoRedirectCreateForm({ copy }: { readonly copy: SeoRedirectCreateCopy }) {
  const router = useRouter();
  const [fromPath, setFromPath] = useState('');
  const [toPath, setToPath] = useState('');
  const [statusCode, setStatusCode] = useState<RedirectStatusCode>(301);
  const [note, setNote] = useState('');
  // Off by default, deliberately. A redirect that starts working the instant somebody presses a button is the one
  // mistake this screen can make that a visitor notices, so the safe state is the default and switching it on is a
  // separate, visible action.
  const [isActive, setIsActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('POST', '/api/seo/redirects', {
      fromPath: fromPath.trim(),
      toPath: toPath.trim(),
      statusCode,
      // A blank note is absent rather than empty: the column is nullable and a blank note is not a note.
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      isActive,
    });

    if (outcome.status === 201) {
      setFromPath('');
      setToPath('');
      setNote('');
      router.refresh();
    } else {
      setProblem(messageFor(outcome, copy));
    }
    setBusy(false);
  }

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-from">
          {copy.fromLabel}
        </label>
        <input
          id="redirect-from"
          className={FIELD_CLASS}
          value={fromPath}
          onChange={(event) => setFromPath(event.target.value)}
          required
          maxLength={REDIRECT_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.fromHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-to">
          {copy.toLabel}
        </label>
        <input
          id="redirect-to"
          className={FIELD_CLASS}
          value={toPath}
          onChange={(event) => setToPath(event.target.value)}
          required
          maxLength={REDIRECT_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.toHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-status">
          {copy.statusLabel}
        </label>
        <select
          id="redirect-status"
          className={FIELD_CLASS}
          value={String(statusCode)}
          onChange={(event) => setStatusCode(Number(event.target.value) as RedirectStatusCode)}
        >
          {REDIRECT_STATUS_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <p className={HINT_CLASS}>{copy.statusHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-note">
          {copy.noteLabel}
        </label>
        <input
          id="redirect-note"
          className={FIELD_CLASS}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={REDIRECT_NOTE_MAX}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="redirect-active"
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        <label className="text-sm text-neutral-700" htmlFor="redirect-active">
          {copy.activeLabel}
        </label>
      </div>
      <p className={HINT_CLASS}>{copy.activeHint}</p>

      <Problem message={problem} />
      <button
        className={BUTTON_CLASS}
        type="submit"
        disabled={busy || fromPath.trim() === '' || toPath.trim() === ''}
      >
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Edit                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoRedirectEditCopy {
  readonly fromLabel: string;
  readonly fromHint: string;
  readonly toLabel: string;
  readonly toHint: string;
  readonly statusLabel: string;
  readonly statusHint: string;
  readonly noteLabel: string;
  readonly noteHint: string;
  readonly submit: string;
  readonly working: string;
  readonly failed: string;
  readonly pathTaken: string;
  readonly notAllowed: string;
  readonly invalid: string;
}

export function SeoRedirectEditForm({
  redirectId,
  initial,
  copy,
}: {
  readonly redirectId: string;
  readonly initial: {
    readonly fromPath: string;
    readonly toPath: string;
    readonly statusCode: RedirectStatusCode;
    readonly note: string | null;
  };
  readonly copy: SeoRedirectEditCopy;
}) {
  const router = useRouter();
  const [fromPath, setFromPath] = useState(initial.fromPath);
  const [toPath, setToPath] = useState(initial.toPath);
  const [statusCode, setStatusCode] = useState<RedirectStatusCode>(initial.statusCode);
  const [note, setNote] = useState(initial.note ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await send('PATCH', '/api/seo/redirects', {
      redirectId,
      fromPath: fromPath.trim(),
      toPath: toPath.trim(),
      statusCode,
      // An empty string clears the note, which is a different request from not sending the field at all.
      note: note.trim(),
    });

    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setBusy(false);
  }

  return (
    <form className="mt-4 max-w-xl space-y-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-edit-from">
          {copy.fromLabel}
        </label>
        <input
          id="redirect-edit-from"
          className={FIELD_CLASS}
          value={fromPath}
          onChange={(event) => setFromPath(event.target.value)}
          required
          maxLength={REDIRECT_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.fromHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-edit-to">
          {copy.toLabel}
        </label>
        <input
          id="redirect-edit-to"
          className={FIELD_CLASS}
          value={toPath}
          onChange={(event) => setToPath(event.target.value)}
          required
          maxLength={REDIRECT_PATH_MAX}
        />
        <p className={HINT_CLASS}>{copy.toHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-edit-status">
          {copy.statusLabel}
        </label>
        <select
          id="redirect-edit-status"
          className={FIELD_CLASS}
          value={String(statusCode)}
          onChange={(event) => setStatusCode(Number(event.target.value) as RedirectStatusCode)}
        >
          {REDIRECT_STATUS_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <p className={HINT_CLASS}>{copy.statusHint}</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="redirect-edit-note">
          {copy.noteLabel}
        </label>
        <input
          id="redirect-edit-note"
          className={FIELD_CLASS}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={REDIRECT_NOTE_MAX}
        />
        <p className={HINT_CLASS}>{copy.noteHint}</p>
      </div>

      <Problem message={problem} />
      <button className={BUTTON_CLASS} type="submit" disabled={busy}>
        {busy ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* State and removal                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoRedirectStateCopy {
  /**
   * The one label for the one state change this entry can make: "switch it on" for an entry that is off, "switch
   * it off" for one that is on.
   *
   * Only one of the two words, deliberately. A client component's props are serialised into the RSC payload, so
   * carrying both would put the words of a control nobody can press into every response — the same leak 8-C found
   * in the vocabulary editor's labels. The server already knows which state the entry is in, so it sends the label
   * that goes with it and nothing else.
   */
  readonly toggle: string;
  /** Shown before the change is confirmed. Empty for switching off, which needs no confirmation. */
  readonly toggleConfirm: string;
  readonly remove: string;
  readonly removeConfirm: string;
  readonly working: string;
  readonly failed: string;
  readonly invalid: string;
}

/**
 * Switching an entry on or off, and removing it.
 *
 * Switching on asks for confirmation, because it is the moment a visitor's address starts going somewhere else.
 * Switching off does not: it stops a redirect, which is the safe direction. Removal asks as well, and sits apart
 * from the other two, because it is the one action here that cannot be undone from this screen.
 */
export function SeoRedirectStateForm({
  redirectId,
  isActive,
  copy,
}: {
  readonly redirectId: string;
  readonly isActive: boolean;
  readonly copy: SeoRedirectStateCopy;
}) {
  const router = useRouter();
  const [confirmingToggle, setConfirmingToggle] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The only change this entry can make, which is the opposite of the state it is in.
  const next = !isActive;

  async function setState(): Promise<void> {
    if (busy) return;
    // Turning one on is the direction that changes what a visitor experiences, so it is the one that asks. The
    // server says so by sending a confirmation sentence; switching off sends an empty one.
    if (copy.toggleConfirm !== '' && !confirmingToggle) {
      setConfirmingToggle(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await send('PUT', '/api/seo/redirects/state', { redirectId, isActive: next });
    if (outcome.status === 200) router.refresh();
    else setProblem(messageFor(outcome, copy));
    setConfirmingToggle(false);
    setBusy(false);
  }

  async function remove(): Promise<void> {
    if (busy) return;
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await send('POST', '/api/seo/redirects/remove', { redirectId });
    if (outcome.status === 200) router.push('/seo/redirects');
    else setProblem(messageFor(outcome, copy));
    setConfirmingRemove(false);
    setBusy(false);
  }

  return (
    <div className="mt-4">
      <Problem message={problem} />
      {confirmingToggle ? <p className="mb-3 text-sm text-neutral-700">{copy.toggleConfirm}</p> : null}
      {confirmingRemove ? <p className="mb-3 text-sm text-neutral-700">{copy.removeConfirm}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button
          className={isActive ? SECONDARY_CLASS : BUTTON_CLASS}
          type="button"
          onClick={() => void setState()}
          disabled={busy}
        >
          {busy ? copy.working : copy.toggle}
        </button>
        <button className={DANGER_CLASS} type="button" onClick={() => void remove()} disabled={busy}>
          {copy.remove}
        </button>
      </div>
    </div>
  );
}
