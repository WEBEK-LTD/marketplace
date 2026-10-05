'use client';

import { useState } from 'react';
import { fileReport, writeFailureMessage, type ReportSubject, type WriteFailureLabels } from './messaging-write';

/**
 * Reporting a message or a conversation (Phase 5-H).
 *
 * Three states and a button — no modal, no overlay, no focus trap, no new framework. The control expands
 * in place into a confirmation, and the confirmation is where the promises are made: that the message
 * stays where it is, and that reporting the same thing twice does not file it twice.
 *
 * What it deliberately does not do:
 *
 * - **It changes nothing about the conversation.** No close, no mute, no block, no leave, no read marker.
 *   The only request it can make is the report itself, because it imports nothing else.
 * - **It removes nothing.** After a successful report the message is still on screen and still says what
 *   it said. Hiding it would be a moderation decision, and a report is a request for one.
 * - **It shows no identifier.** The subject travels in the request body; nothing here renders an id, and
 *   nothing here carries one in an attribute.
 * - **It sends no message text.** The report names the subject by id and carries no details field, so the
 *   body cannot reach report metadata through this surface.
 */

export interface ReportCopy extends WriteFailureLabels {
  /** The button, before anything is confirmed. */
  readonly action: string;
  /** What the confirmation asks, which differs for a message and a conversation. */
  readonly confirmation: string;
  /** That a repeat does not file a second report. */
  readonly once: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
  readonly done: string;
}

export interface ReportActionProps {
  readonly subject: ReportSubject;
  readonly copy: ReportCopy;
}

const LINK_CLASS =
  'text-xs underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900 disabled:opacity-60';
const BUTTON_CLASS =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-60';

export function ReportAction({ subject, copy }: ReportActionProps) {
  const [state, setState] = useState<'idle' | 'confirming' | 'sending' | 'done'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (state === 'sending') return;
    setMessage(null);
    setState('sending');

    const result = await fileReport(subject, (input, init) => fetch(input, init));

    if (result.kind === 'ok') {
      // A first report and a repeat arrive here identically, which is the point: the platform's reporting
      // lands a second submission on the report already open, so there is one thing to say.
      setState('done');
      return;
    }
    setState('confirming');
    setMessage(
      result.kind === 'refused' ? writeFailureMessage(result.status, result.code, copy) : copy.failed,
    );
  }

  if (state === 'done') {
    return (
      <p role="status" className="mt-2 text-xs text-neutral-600">
        {copy.done}
      </p>
    );
  }

  if (state === 'idle') {
    return (
      <p className="mt-2">
        <button type="button" className={LINK_CLASS} onClick={() => setState('confirming')}>
          {copy.action}
        </button>
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-xs text-neutral-900">{copy.confirmation}</p>
      <p className="mt-1 text-xs text-neutral-600">{copy.once}</p>
      <p aria-live="polite" role="status" className="min-h-4 text-xs text-neutral-900">
        {message}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={state === 'sending'}
          className={BUTTON_CLASS}
          onClick={() => void onConfirm()}
        >
          {state === 'sending' ? copy.working : copy.confirm}
        </button>
        <button
          type="button"
          disabled={state === 'sending'}
          className={LINK_CLASS}
          onClick={() => {
            setMessage(null);
            setState('idle');
          }}
        >
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}
