'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

/**
 * The two attachment controls on a conversation (0104).
 *
 * **Download** asks this origin for a signed link and opens it. The link lasts ten minutes and is not held
 * anywhere: it is requested when somebody clicks, used, and forgotten. Nothing is cached, nothing is rendered
 * into the document, and the component holds an attachment id — not a path, a bucket or a URL.
 *
 * **Attach** is the three-step flow, driven from here because only a browser has the bytes:
 *
 *   1. ask this origin to authorize an upload, which answers with one object path and one signed URL;
 *   2. `PUT` the file to that URL — the only request in this component that does not go to this origin, and it
 *      goes to the storage provider the server named rather than anywhere this code chose;
 *   3. ask this origin to record it, which the server does only after confirming the object arrived.
 *
 * **A failure at step two or three leaves no row.** That is the whole reason the flow has three steps rather
 * than one, and it is why every failure here is safe to retry: the worst case is an uploaded object nothing
 * points at, which costs storage and misleads nobody.
 *
 * **The type and size are checked here and again twice on the server.** This check exists so somebody is told
 * before they wait for an upload, not because it is the authority — the API's schema and the database's
 * allowlist are, and both refuse independently.
 */

const BUTTON_CLASS =
  'rounded-md border border-edge px-2 py-0.5 text-xs font-medium text-ink-strong disabled:opacity-60';

/** The four types 0104 permits, and the only ones the picker offers. SVG is absent deliberately. */
const ACCEPTED = 'image/jpeg,image/png,image/webp,application/pdf';
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BYTES = 10_485_760;

export interface AttachmentCopy {
  readonly download: string;
  readonly opening: string;
  readonly downloadFailed: string;
  readonly attach: string;
  readonly uploading: string;
  readonly attached: string;
  readonly tooLarge: string;
  readonly wrongType: string;
  readonly tooMany: string;
  readonly attachFailed: string;
  readonly blocked: string;
}

/* ------------------------------------------------------------------------------------------------ */

/**
 * One download link.
 *
 * A button rather than an anchor, because the destination does not exist until it is asked for and an anchor
 * with no `href` is a lie to a keyboard user. The window is opened from the click's own handler so a popup
 * blocker treats it as user-initiated.
 */
export function AttachmentDownload({
  conversationId,
  attachmentId,
  copy,
}: {
  readonly conversationId: string;
  readonly attachmentId: string;
  readonly copy: AttachmentCopy;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open(): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const response = await fetch(
        `/api/messaging/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/link`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== 'string') {
        setFailed(true);
        return;
      }
      // `noopener` so the opened document cannot reach back into this one.
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => void open()} disabled={pending} className={BUTTON_CLASS}>
        {pending ? copy.opening : copy.download}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-ink-strong">
          {copy.downloadFailed}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ */

type AttachState = 'idle' | 'working' | 'done' | 'error';

/**
 * The attach control, offered on the caller's own messages only.
 *
 * Which messages those are is the server's decision — this component is rendered for a message the page
 * already knows is the caller's own, and the database refuses anything else regardless. There is no
 * "attachment-only message" control anywhere, because a message always has text (owner decision 5) and this
 * attaches to one that already exists.
 */
export function AttachToMessage({
  conversationId,
  messageId,
  copy,
}: {
  readonly conversationId: string;
  readonly messageId: string;
  readonly copy: AttachmentCopy;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AttachState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  function fail(text: string): void {
    setState('error');
    setMessage(text);
  }

  async function send(file: File): Promise<void> {
    // Checked here so somebody is told before an upload, never instead of the server checking.
    if (!ACCEPTED_TYPES.has(file.type)) {
      fail(copy.wrongType);
      return;
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      fail(copy.tooLarge);
      return;
    }

    setState('working');
    setMessage(null);

    const base = `/api/messaging/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments`;

    // Step one. The server answers with the one path this file may go to.
    let authorized: { uploadUrl: string; objectPath: string };
    try {
      const response = await fetch(`${base}/uploads`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, byteSize: file.size }),
      });
      if (!response.ok) {
        fail(await refusalText(response, copy));
        return;
      }
      const body = (await response.json()) as { upload?: { uploadUrl?: unknown; objectPath?: unknown } };
      const upload = body.upload;
      if (typeof upload?.uploadUrl !== 'string' || typeof upload?.objectPath !== 'string') {
        fail(copy.attachFailed);
        return;
      }
      authorized = { uploadUrl: upload.uploadUrl, objectPath: upload.objectPath };
    } catch {
      fail(copy.attachFailed);
      return;
    }

    // Step two. The only request here that leaves this origin, to the URL the server named.
    try {
      const uploaded = await fetch(authorized.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!uploaded.ok) {
        // No row exists, so retrying is safe and changes nothing.
        fail(copy.attachFailed);
        return;
      }
    } catch {
      fail(copy.attachFailed);
      return;
    }

    // Step three. The server confirms the object arrived before it records anything.
    try {
      const recorded = await fetch(base, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objectPath: authorized.objectPath,
          contentType: file.type,
          byteSize: file.size,
        }),
      });
      if (!recorded.ok) {
        fail(await refusalText(recorded, copy));
        return;
      }
    } catch {
      fail(copy.attachFailed);
      return;
    }

    setState('done');
    setMessage(copy.attached);
    // The thread comes back from the server, so what appears is what committed.
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again fires a change event.
          event.target.value = '';
          if (file !== undefined) void send(file);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={state === 'working'}
        className={BUTTON_CLASS}
      >
        {state === 'working' ? copy.uploading : copy.attach}
      </button>
      {message !== null && (
        <span role={state === 'error' ? 'alert' : 'status'} className="text-xs text-ink-strong">
          {message}
        </span>
      )}
    </span>
  );
}

/**
 * One refusal to one sentence.
 *
 * The problem code is read because two refusals have remedies somebody can act on: the message is full, or the
 * pair is blocked. Everything else is one failure, because "that did not work, try again" is the whole of what
 * can honestly be said about the rest.
 */
async function refusalText(response: Response, copy: AttachmentCopy): Promise<string> {
  let code: string | null = null;
  try {
    const body = (await response.json()) as { code?: unknown };
    code = typeof body.code === 'string' ? body.code : null;
  } catch {
    code = null;
  }
  if (code === 'MESSAGE_ATTACHMENT_LIMIT_REACHED') return copy.tooMany;
  if (code === 'MESSAGING_BLOCKED') return copy.blocked;
  if (code === 'MESSAGE_ATTACHMENT_OBJECT_MISSING') return copy.attachFailed;
  return copy.attachFailed;
}
