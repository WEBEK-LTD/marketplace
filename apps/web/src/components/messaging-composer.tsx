'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  MESSAGE_BODY_MAX_LENGTH,
  closeConversation,
  composerState,
  leaveConversation,
  markRead,
  prepareBody,
  sendMessage,
  setMuted,
  writeFailureMessage,
  type WriteFailureLabels,
  type WriteResult,
} from './messaging-write';

/**
 * The composer and the conversation controls (Phase 5-E).
 *
 * Both are thin: every rule they follow lives in `messaging-write.ts`, which is what the suite tests, and
 * what remains here is state and markup. What they deliberately do **not** contain is as important:
 *
 * - **No optimistic message.** The draft is cleared and the thread refreshed only after a 201 whose body
 *   parsed. Anything else leaves the text in the box, says why, and re-enables the button — a person who
 *   lost a paragraph to a failed request has lost more than the request.
 * - **No polling and no subscription.** A successful write calls `router.refresh()` once, so the server
 *   re-renders the thread from the read model that just committed. Live updates are 5-F and 5-I.
 * - **No edit, no delete, no reopen.** There are no such controls because there are no such operations.
 * - **No identifiers.** Nothing in this file renders a user id; attribution is the thread's job and it
 *   says only "You" or "Other participant".
 *
 * Leaving and closing cannot be undone, and this increment adds no confirmation step for them, because a
 * confirmation needs its own approved wording in both locales. What it does instead is remove each button
 * once its effect has happened, so neither can be pressed twice by someone who is not sure it worked.
 */

const BUTTON_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-3 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';

export interface ComposerLabels extends WriteFailureLabels {
  readonly placeholder: string;
  readonly send: string;
  readonly sending: string;
  readonly tooLong: string;
  readonly sendFailed: string;
  /** Why the composer is disabled: the conversation is closed. */
  readonly closedHint: string;
  /** Why the composer is disabled: the caller has left. */
  readonly leftHint: string;
  /** The accessible name of the text area. */
  readonly label: string;
}

export interface MessageComposerProps {
  readonly conversationId: string;
  readonly isClosed: boolean;
  readonly hasLeft: boolean;
  readonly labels: ComposerLabels;
}

/** The single text field and its send button. Disabled, with a reason, when the thread is not writable. */
export function MessageComposer({ conversationId, isClosed, hasLeft, labels }: MessageComposerProps) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const state = composerState({ isClosed, hasLeft });
  const writable = state === 'open';

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || !writable) return;
    setMessage(null);

    const prepared = prepareBody(draft);
    if ('problem' in prepared) {
      // An empty draft is not an error worth a sentence — it is simply not a message. Too long is, because
      // the person cannot see the limit being crossed.
      if (prepared.problem === 'too_long') setMessage(labels.tooLong);
      return;
    }

    setPending(true);
    const result = await sendMessage(conversationId, prepared.body, (input, init) => fetch(input, init));
    setPending(false);

    if (result.kind === 'ok') {
      setDraft('');
      router.refresh();
      return;
    }
    setMessage(
      result.kind === 'refused'
        ? writeFailureMessage(result.status, result.code, labels)
        : labels.sendFailed,
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 border-t border-hairline pt-6">
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
        {message ?? (state === 'closed' ? labels.closedHint : state === 'left' ? labels.leftHint : null)}
      </p>
      <label htmlFor="message-body" className="sr-only">
        {labels.label}
      </label>
      <textarea
        id="message-body"
        name="body"
        rows={3}
        maxLength={MESSAGE_BODY_MAX_LENGTH}
        disabled={!writable || pending}
        placeholder={labels.placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none disabled:bg-surface-sunken"
      />
      <div className="mt-3 flex justify-end">
        <button type="submit" disabled={!writable || pending} className={BUTTON_CLASS}>
          {pending ? labels.sending : labels.send}
        </button>
      </div>
    </form>
  );
}

export interface ControlLabels extends WriteFailureLabels {
  readonly markRead: string;
  readonly mute: string;
  readonly unmute: string;
  readonly leave: string;
  readonly close: string;
  readonly working: string;
  readonly actionFailed: string;
  readonly groupLabel: string;
}

export interface ConversationControlsProps {
  readonly conversationId: string;
  /** The newest sequence the caller can see, or `null` when the thread is empty. */
  readonly latestSeq: string | null;
  readonly isMuted: boolean;
  readonly isClosed: boolean;
  readonly hasLeft: boolean;
  readonly labels: ControlLabels;
}

/**
 * Mark as read, mute, leave, close.
 *
 * Marking read needs a sequence, so the button is absent on an empty thread rather than present and
 * meaningless. Leaving and closing are absent once they have happened: the thread already says so, and a
 * button whose only effect is to repeat itself invites a second confirmation for nothing.
 */
export function ConversationControls({
  conversationId,
  latestSeq,
  isMuted,
  isClosed,
  hasLeft,
  labels,
}: ConversationControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run<T>(name: string, action: () => Promise<WriteResult<T>>): Promise<void> {
    if (busy !== null) return;
    setMessage(null);
    setBusy(name);
    const result = await action();
    setBusy(null);
    if (result.kind === 'ok') {
      router.refresh();
      return;
    }
    setMessage(
      result.kind === 'refused'
        ? writeFailureMessage(result.status, result.code, labels)
        : labels.actionFailed,
    );
  }

  const fetcher = (input: string, init: RequestInit) => fetch(input, init);
  const label = (name: string, text: string) => (busy === name ? labels.working : text);

  return (
    <section aria-label={labels.groupLabel} className="mt-6">
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
        {message}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {latestSeq === null ? null : (
          <button
            type="button"
            disabled={busy !== null}
            className={SECONDARY_CLASS}
            onClick={() => void run('read', () => markRead(conversationId, latestSeq, fetcher))}
          >
            {label('read', labels.markRead)}
          </button>
        )}
        <button
          type="button"
          disabled={busy !== null}
          className={SECONDARY_CLASS}
          onClick={() => void run('muted', () => setMuted(conversationId, !isMuted, fetcher))}
        >
          {label('muted', isMuted ? labels.unmute : labels.mute)}
        </button>
        {hasLeft ? null : (
          <button
            type="button"
            disabled={busy !== null}
            className={SECONDARY_CLASS}
            onClick={() => void run('leave', () => leaveConversation(conversationId, fetcher))}
          >
            {label('leave', labels.leave)}
          </button>
        )}
        {isClosed || hasLeft ? null : (
          <button
            type="button"
            disabled={busy !== null}
            className={SECONDARY_CLASS}
            onClick={() => void run('close', () => closeConversation(conversationId, fetcher))}
          >
            {label('close', labels.close)}
          </button>
        )}
      </div>
    </section>
  );
}
