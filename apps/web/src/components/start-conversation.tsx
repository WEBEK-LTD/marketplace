'use client';

import { useRouter } from 'next/navigation';
import { trackListingEvent } from './listing-beacon';
import Link from 'next/link';
import { useState } from 'react';
import {
  startDirectConversation,
  startListingConversation,
  writeFailureMessage,
} from './messaging-write';
import type { StartConversationLabels } from './start-conversation-labels';

/**
 * The contact action on a listing detail page and on a public seller profile (Phase 5-E).
 *
 * **Why it carries no session state.** Both pages are public and cacheable, and reading the session on
 * them would change what those frozen surfaces are. So this button does not know whether the visitor is
 * signed in and does not ask: it offers the action, and a 401 from the BFF — the only authority on that
 * question — turns it into a link to sign in. Nothing about the visitor is rendered either way, so the
 * markup is identical for everybody and stays cacheable.
 *
 * **Why the seller is named by slug.** The public seller profile exposes five fields and the seller's
 * identifier is not one of them (4-E). The slug is already in the page's own URL, so it is what travels;
 * resolution to a user id happens inside the database and no identifier reaches the browser.
 *
 * On success the visitor is sent to the conversation — created or already open, both of which are
 * success — under `/dashboard/messages`, which is where messaging lives for buyers and sellers alike.
 */

export type StartConversationSubject =
  | { readonly kind: 'listing'; readonly listingId: string }
  | { readonly kind: 'seller'; readonly sellerSlug: string };

export interface StartConversationProps {
  readonly subject: StartConversationSubject;
  /** `/dashboard/messages` under the active locale. The conversation id is appended on success. */
  readonly messagesPath: string;
  /** Where to send a visitor who turns out not to be signed in. */
  readonly loginPath: string;
  readonly labels: StartConversationLabels;
}

export function StartConversationButton({
  subject,
  messagesPath,
  loginPath,
  labels,
}: StartConversationProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  async function onClick(): Promise<void> {
    if (pending) return;
    // 0101: contacting a seller about a listing is one of the four ingested event types. Queued before the
    // request, because the event is the visitor's action and not its outcome — a conversation that fails to
    // open was still an attempt to make contact, and the beacon never blocks the click either way.
    if (subject.kind === 'listing') {
      trackListingEvent({ listingId: subject.listingId, eventType: 'contact', source: 'listing' });
    }
    setMessage(null);
    setPending(true);
    const fetcher = (input: string, init: RequestInit) => fetch(input, init);
    const result =
      subject.kind === 'listing'
        ? await startListingConversation(subject.listingId, fetcher)
        : await startDirectConversation(subject.sellerSlug, fetcher);
    setPending(false);

    if (result.kind === 'ok') {
      router.push(`${messagesPath}/${result.data.conversationId}`);
      return;
    }
    if (result.kind === 'refused' && result.status === 401) {
      // The BFF is the only thing that knows; now that it has said so, offer the way in.
      setSignedOut(true);
      return;
    }
    setMessage(
      result.kind === 'refused'
        ? writeFailureMessage(result.status, result.code, labels)
        : labels.failed,
    );
  }

  return (
    <div>
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
        {message}
      </p>
      {signedOut ? (
        <Link
          href={loginPath}
          className="mt-1 inline-block rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink"
        >
          {labels.signIn}
        </Link>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => void onClick()}
          className="mt-1 rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60"
        >
          {pending ? labels.working : labels.action}
        </button>
      )}
    </div>
  );
}
