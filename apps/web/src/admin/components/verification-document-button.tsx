'use client';

import { useState } from 'react';
import { adminApiPath } from '../paths';

/**
 * One short-lived look at one private document (Phase 7-G).
 *
 * **The markup carries no location.** This component knows two identifiers, both of which name rows, and
 * nothing else: no bucket, no object path, no provider key, no signed URL. A page's HTML and its RSC
 * payload therefore contain nothing that would survive being saved, shared or scraped.
 *
 * **The authorization is asked for at the moment of the click**, not baked into the page when it
 * rendered. A URL that is minted on demand and expires shortly afterwards is a much smaller thing to
 * leak than one sitting in every copy of a queue page, and it means a reviewer who leaves a tab open
 * overnight holds nothing.
 *
 * It opens the answer in a new tab with `noopener,noreferrer`, so the opened page cannot reach back into
 * the console and the console's own address is not sent to storage as a referrer.
 */

export interface DocumentLabels {
  readonly view: string;
  readonly working: string;
  readonly failed: string;
}

export function VerificationDocumentButton({
  verificationId,
  documentId,
  labels,
}: {
  readonly verificationId: string;
  readonly documentId: string;
  readonly labels: DocumentLabels;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open(): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const response = await fetch(adminApiPath('/api/sellers/verification/document'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verificationId, documentId }),
      });
      if (response.status !== 200) {
        setFailed(true);
        return;
      }
      const body: unknown = await response.json();
      const url =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : null;
      if (typeof url !== 'string' || url === '') {
        setFailed(true);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <p className="mt-3 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void open()}
        disabled={pending}
        className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink-strong disabled:opacity-60"
      >
        {pending ? labels.working : labels.view}
      </button>
      {failed && (
        <span role="alert" className="text-sm text-ink-strong">
          {labels.failed}
        </span>
      )}
    </p>
  );
}
