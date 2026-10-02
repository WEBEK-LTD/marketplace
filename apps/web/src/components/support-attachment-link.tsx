'use client';

import { useState } from 'react';
import { supportAttachmentLink, supportFailureMessage, type SupportFailureLabels } from './support';

/**
 * The one button that opens a file on a ticket (Phase 7-K).
 *
 * **A link is not rendered into the page.** It is a bearer credential for one object for a few minutes, so
 * asking for it at the moment somebody presses is the only way to hand one over that does not leave it lying
 * in an RSC payload, in a browser's history, or in a page somebody left open.
 *
 * It sends two identifiers and receives a URL. There is no path in what it sends and none in what comes back:
 * the server resolves the object from the attachment's own row, and refuses an attachment that does not belong
 * to the ticket in the route.
 *
 * The URL is opened in a new tab and never stored in state, so it is not re-usable from this component after
 * the press; asking again asks the server again.
 */

export interface AttachmentCopy extends SupportFailureLabels {
  readonly open: string;
  readonly opening: string;
}

export function SupportAttachmentLink({
  ticketId,
  attachmentId,
  copy,
}: {
  readonly ticketId: string;
  readonly attachmentId: string;
  readonly copy: AttachmentCopy;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    const result = await supportAttachmentLink(ticketId, attachmentId, (input, init) =>
      fetch(input, init),
    );
    setPending(false);

    if (result.kind !== 'ok') {
      setError(supportFailureMessage(result.kind, copy));
      return;
    }
    // `noopener` so the opened document cannot reach back into this one.
    window.open(result.url, '_blank', 'noopener,noreferrer');
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => void open()}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-60"
      >
        {pending ? copy.opening : copy.open}
      </button>
      {error !== null && (
        <span role="alert" className="text-xs font-medium text-neutral-900">
          {error}
        </span>
      )}
    </>
  );
}
