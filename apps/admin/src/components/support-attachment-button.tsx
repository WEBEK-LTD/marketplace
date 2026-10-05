'use client';

import { useState } from 'react';
import type { ConsoleFailureCopy } from './support-console-forms';

/**
 * One short-lived look at one file on a support ticket (Phase 7-L).
 *
 * **The markup carries no location.** This component knows two identifiers, both of which name rows, and
 * nothing else: no bucket, no object path, no provider key, no signed URL. A page's HTML and its RSC payload
 * therefore contain nothing that would survive being saved, shared or scraped.
 *
 * **The authorization is asked for at the moment of the click**, not baked into the page when it rendered. A
 * URL minted on demand and expiring shortly afterwards is a much smaller thing to leak than one sitting in
 * every copy of a ticket page, and a colleague who leaves a tab open overnight holds nothing.
 *
 * It opens the answer in a new tab with `noopener,noreferrer`, so the opened page cannot reach back into the
 * console and the console's own address is not sent to storage as a referrer.
 */

export interface AttachmentCopy extends ConsoleFailureCopy {
  readonly open: string;
  readonly opening: string;
}

export function SupportAttachmentButton({
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
    try {
      const query = new URLSearchParams({ ticketId, attachmentId });
      const response = await fetch(`/api/support/attachment?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (response.status !== 200) {
        setError(
          response.status === 401
            ? copy.signedOut
            : response.status === 404
              ? copy.notFound
              : copy.unavailable,
        );
        return;
      }
      const body: unknown = await response.json();
      const url =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : null;
      if (typeof url !== 'string' || url === '') {
        setError(copy.unavailable);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError(copy.unavailable);
    } finally {
      setPending(false);
    }
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
