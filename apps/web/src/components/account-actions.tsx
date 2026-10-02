'use client';

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
