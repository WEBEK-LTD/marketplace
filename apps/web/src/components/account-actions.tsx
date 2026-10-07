'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { accountRequest } from './account-request';

/**
 * The small destructive actions on the buyer account surfaces (Phase 7-E).
 *
 * Thin by design. Each holds **one identifier and three words** — nothing else about a favorite, a saved
 * search or an address crosses into the browser through these props, because a client component's props
 * travel in the RSC payload and everything a person reads is already rendered on the server.
 *
 * Each posts to a BFF route on this origin and reads only the outcome. There is no Supabase client, no
 * credential, no token and no account: the session is an `HttpOnly` cookie this code cannot read, and
 * the account the server acts on is resolved from it, never named here.
 *
 * **All three are idempotent, which is why a failure is safe to retry.** Removing something that is
 * already gone changes nothing and still succeeds, so a button pressed twice, or pressed again after a
 * timeout, cannot do anything the person did not ask for.
 *
 * After a successful action the server is asked to re-render, so the list that comes back is the
 * database's answer rather than arithmetic this component did on a number it was given.
 */

export interface RemoveCopy {
  readonly remove: string;
  readonly working: string;
  readonly failed: string;
}

const BUTTON_CLASS =
  'rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-60';

function useRemover(path: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run(): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const outcome = await accountRequest(path, { method: 'DELETE' });
      if (outcome.status === 'ok') {
        router.refresh();
        return;
      }
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return { pending, failed, run };
}

function RemoveButton({
  copy,
  state,
}: {
  readonly copy: RemoveCopy;
  readonly state: { pending: boolean; failed: boolean; run: () => Promise<void> };
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void state.run()} disabled={state.pending} className={BUTTON_CLASS}>
        {state.pending ? copy.working : copy.remove}
      </button>
      {state.failed && (
        <span role="alert" className="text-xs text-neutral-900">
          {copy.failed}
        </span>
      )}
    </span>
  );
}

export function RemoveFavorite({
  listingId,
  copy,
}: {
  readonly listingId: string;
  readonly copy: RemoveCopy;
}) {
  const state = useRemover(`/api/account/favorites/${listingId}`);
  return <RemoveButton copy={copy} state={state} />;
}

export function DeleteSavedSearch({
  savedSearchId,
  copy,
}: {
  readonly savedSearchId: string;
  readonly copy: RemoveCopy;
}) {
  const state = useRemover(`/api/account/saved-searches/${savedSearchId}`);
  return <RemoveButton copy={copy} state={state} />;
}

export function DeleteAddress({
  addressId,
  copy,
}: {
  readonly addressId: string;
  readonly copy: RemoveCopy;
}) {
  const state = useRemover(`/api/account/addresses/${addressId}`);
  return <RemoveButton copy={copy} state={state} />;
}

/**
 * Unblocking somebody (0103).
 *
 * The prop is the opaque reference the list response carried, not an account identifier — which matters
 * here more than anywhere else in this file, because a client component's props travel in the RSC payload
 * whether or not the component renders them. There is nothing to leak in this one.
 */
export function UnblockPerson({
  reference,
  copy,
}: {
  readonly reference: string;
  readonly copy: RemoveCopy;
}) {
  const state = useRemover(`/api/account/blocks/${encodeURIComponent(reference)}`);
  return <RemoveButton copy={copy} state={state} />;
}

export interface BlockCopy {
  readonly block: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly explain: string;
  readonly working: string;
  readonly done: string;
  readonly failed: string;
  readonly signIn: string;
}

/**
 * Blocking somebody, from a conversation or from a storefront (0103).
 *
 * **A handle, never an account.** The prop is either a conversation this person is in or a seller slug
 * they are looking at — both of which the page already had, and neither of which is an account identifier.
 * Which person it resolves to is decided inside one database function.
 *
 * **Two presses, because this one is consequential.** Unlike the removals above, blocking changes what
 * somebody else can do and is not something to do by brushing a button: the first press asks, the second
 * acts. It is still idempotent underneath, so a retry after a timeout is safe.
 *
 * **It says what it did and stops.** After a block the server is asked to re-render, because what happens
 * next — whether a reply box is still there, whether a Contact button still works — is the server's answer
 * and not something this component should decide locally.
 */
export function BlockPerson({
  handle,
  loginPath,
  copy,
}: {
  readonly handle: { readonly conversationId: string } | { readonly sellerSlug: string };
  /**
   * Where to send a visitor who turns out not to be signed in.
   *
   * Offered rather than pre-checked, which is what lets this control sit on a **public** page without that
   * page reading a session: the storefront is a cached catalogue surface, and making it personalised to
   * decide whether to draw a button would change its caching. So the button is drawn for everybody and the
   * BFF — the only layer that can see the session cookie — is what discovers there is none.
   */
  readonly loginPath?: string;
  readonly copy: BlockCopy;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<'idle' | 'done' | 'failed' | 'signed-out'>('idle');

  async function run(): Promise<void> {
    if (pending) return;
    setPending(true);
    setState('idle');
    try {
      const outcome = await accountRequest('/api/account/blocks', { method: 'POST', body: handle });
      if (outcome.status === 'ok') {
        setAsking(false);
        setState('done');
        router.refresh();
        return;
      }
      if (outcome.status === 'signed-out' && loginPath !== undefined) {
        setAsking(false);
        setState('signed-out');
        return;
      }
      setState('failed');
    } finally {
      setPending(false);
    }
  }

  if (state === 'signed-out' && loginPath !== undefined) {
    return (
      <Link href={loginPath} className={BUTTON_CLASS}>
        {copy.signIn}
      </Link>
    );
  }

  if (state === 'done') {
    return (
      <span role="status" className="text-xs text-neutral-900">
        {copy.done}
      </span>
    );
  }

  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className={BUTTON_CLASS}>
        {copy.block}
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-600">{copy.explain}</span>
      <button type="button" onClick={() => void run()} disabled={pending} className={BUTTON_CLASS}>
        {pending ? copy.working : copy.confirm}
      </button>
      <button type="button" onClick={() => setAsking(false)} disabled={pending} className={BUTTON_CLASS}>
        {copy.cancel}
      </button>
      {state === 'failed' && (
        <span role="alert" className="text-xs text-neutral-900">
          {copy.failed}
        </span>
      )}
    </span>
  );
}
