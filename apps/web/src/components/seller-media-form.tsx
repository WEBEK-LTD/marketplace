'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { SellerMediaKind } from '@repo/contracts';
import { MEDIA_ACCEPT, checkChosenFile, runUpload } from './seller-media-upload';

/**
 * The seller media upload controls (Phase 6-E).
 *
 * Two file inputs — a logo and a banner — and nothing else. The minimum the increment asked for: no cropper, no
 * preview gallery, no drag-and-drop zone, no deletion, no reordering, no alt-text editor.
 *
 * **What crosses the server/client boundary.** Copy. Every prop below is a string, so the page's RSC payload
 * carries this form's wording and no data: no object path, no bucket, no signed URL, no identifier, no token.
 * The current media state is not a prop either — it cannot be, since the seller identity carries no media —
 * so the component starts by knowing nothing and shows only what the server confirms during the session.
 *
 * **No optimistic mutation.** `uploaded` is set only after the confirmation step returned, which happens only
 * after the bytes were accepted by storage. A failed PUT reports unavailable and never confirms, so the state
 * this form displays is always one the server established. The route is refreshed afterwards so the page
 * re-reads the storefront rather than trusting this component's memory.
 *
 * **The signed URL never touches this component.** It lives inside {@link runUpload} for the duration of one
 * call — not in state, not in a ref, not in an attribute, and nowhere a React devtools panel or an error
 * boundary could surface it.
 */

export interface SellerMediaFormLabels {
  readonly title: string;
  readonly logo: string;
  readonly banner: string;
  readonly chooseFile: string;
  readonly upload: string;
  readonly uploading: string;
  readonly uploaded: string;
  readonly noFile: string;
  readonly typeNotAllowed: string;
  readonly tooLarge: string;
  readonly errorUnavailable: string;
  readonly notEditable: string;
  readonly retry: string;
  readonly allowedTypes: string;
}

const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';
const FIELD_CLASS = 'mt-1 block w-full text-sm text-ink-strong';

function MediaField({
  mediaKind,
  heading,
  labels,
  onDone,
}: {
  readonly mediaKind: SellerMediaKind;
  readonly heading: string;
  readonly labels: SellerMediaFormLabels;
  readonly onDone: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setDone(false);

    const file = input.current?.files?.[0] ?? null;
    const checked = checkChosenFile(file === null ? null : { type: file.type, size: file.size });
    if (!checked.ok) {
      if (checked.reason === 'missing') setMessage(labels.noFile);
      else if (checked.reason === 'type') setMessage(labels.typeNotAllowed);
      else setMessage(labels.tooLarge);
      return;
    }
    if (file === null) return;

    setPending(true);
    try {
      const outcome = await runUpload(mediaKind, { type: file.type, size: file.size, body: file });
      if (outcome.kind === 'uploaded') {
        setDone(true);
        onDone();
        return;
      }
      if (outcome.kind === 'not_editable') setMessage(labels.notEditable);
      else if (outcome.kind === 'invalid') setMessage(labels.typeNotAllowed);
      else setMessage(labels.errorUnavailable);
    } finally {
      setPending(false);
    }
  }

  const inputId = `seller-media-${mediaKind}`;

  return (
    <form onSubmit={onSubmit} noValidate className="border-t border-hairline py-4">
      <label htmlFor={inputId} className={LABEL_CLASS}>
        {heading}
      </label>
      <input
        ref={input}
        id={inputId}
        name={mediaKind}
        type="file"
        accept={MEDIA_ACCEPT}
        aria-describedby={`${inputId}-types`}
        className={FIELD_CLASS}
      />
      <p id={`${inputId}-types`} className="mt-1 text-sm text-ink-muted">
        {labels.allowedTypes}
      </p>

      {message === null ? null : (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {message} — {labels.retry}
        </p>
      )}
      {done && message === null ? (
        <p role="status" className="mt-2 text-sm text-ink-strong">
          {labels.uploaded}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-3 inline-flex items-center rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
      >
        {pending ? labels.uploading : labels.upload}
      </button>
    </form>
  );
}

export function SellerMediaForm({ labels }: { readonly labels: SellerMediaFormLabels }) {
  const router = useRouter();

  return (
    <section aria-labelledby="seller-media-heading" className="mt-8 max-w-xl">
      <h2 id="seller-media-heading" className="text-lg font-semibold text-ink-strong">
        {labels.title}
      </h2>

      <MediaField
        mediaKind="logo"
        heading={labels.logo}
        labels={labels}
        onDone={() => router.refresh()}
      />
      <MediaField
        mediaKind="banner"
        heading={labels.banner}
        labels={labels}
        onDone={() => router.refresh()}
      />
    </section>
  );
}
