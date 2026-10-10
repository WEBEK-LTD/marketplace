'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import {
  CMS_MEDIA_ALT_TEXT_MAX,
  CMS_MEDIA_CONTENT_TYPES,
  CMS_MEDIA_MAX_BYTES,
  CMS_MEDIA_OBJECT_PATH_PATTERN,
} from '@repo/contracts';
import { adminApiPath, adminPath } from '../paths';

/**
 * The CMS media library controls (0098).
 *
 * **An upload is three steps and the middle one is not ours.** This origin authorizes the upload, the browser PUTs the
 * bytes straight to the signed URL, and this origin confirms. The bytes never pass through the admin server, which is
 * the whole point of a signed upload.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No path field.** The authorization request carries a type and a size; the path comes back from the server and is
 *   sent back unchanged. There is nothing here a person could type that becomes part of a path.
 * - **No image processing, no cropping, no resizing.** What is uploaded is what is stored. A variant pipeline is Phase
 *   4's for listing images and is not this library's.
 * - **No public URL anywhere.** A preview is a short-lived signed URL fetched when an operator asks for it, and it is
 *   never written into a link somebody could share.
 * - **No delete without its references.** The delete button is only rendered once the screen has fetched and shown
 *   what deleting would blank.
 * - **No optimistic state.** A failed upload leaves the picker as it was.
 */

const BUTTON_CLASS = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';
const LABEL_CLASS = 'block text-sm font-medium text-ink-body';
const HINT_CLASS = 'mt-1 text-xs text-ink-muted';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
  readonly body: unknown;
}

async function send(
  path: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT' = 'POST',
): Promise<Outcome> {
  try {
    const response = await fetch(adminApiPath(path), {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    let code: string | null = null;
    try {
      parsed = JSON.parse(await response.text());
      const payload = parsed as { code?: unknown };
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      parsed = null;
    }
    return { status: response.status, code, body: parsed };
  } catch {
    return { status: null, code: null, body: null };
  }
}

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {message}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Uploading                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsMediaUploadCopy {
  readonly fileLabel: string;
  readonly fileHint: string;
  readonly altTextEnLabel: string;
  readonly altTextArLabel: string;
  readonly altTextHint: string;
  readonly submit: string;
  readonly working: string;
  readonly tooLarge: string;
  readonly wrongType: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
  readonly objectMissing: string;
  readonly pathTaken: string;
  readonly uploadFailed: string;
}

/** The browser's own reading of the image it is about to upload. Display metadata; nothing depends on it. */
async function dimensionsOf(file: File): Promise<{ width?: number; height?: number }> {
  if (typeof window === 'undefined' || typeof window.createImageBitmap !== 'function') return {};
  try {
    const bitmap = await window.createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

export function CmsMediaUploadForm({ copy }: { readonly copy: CmsMediaUploadCopy }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [altEn, setAltEn] = useState('');
  const [altAr, setAltAr] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  function messageFor(outcome: Outcome): string {
    if (outcome.code === 'CMS_MEDIA_NOT_ALLOWED') return copy.notAllowed;
    if (outcome.code === 'CMS_MEDIA_OBJECT_MISSING') return copy.objectMissing;
    if (outcome.code === 'CMS_MEDIA_PATH_TAKEN') return copy.pathTaken;
    if (outcome.status === 400) return copy.invalid;
    return copy.failed;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);

    const file = input.current?.files?.[0] ?? null;
    if (file === null) return;

    // Refused in the browser so an operator is told before a round trip. The bucket refuses it regardless.
    if (!(CMS_MEDIA_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setMessage(copy.wrongType);
      return;
    }
    if (file.size <= 0 || file.size > CMS_MEDIA_MAX_BYTES) {
      setMessage(copy.tooLarge);
      return;
    }

    setWorking(true);

    // 1. Authorize. The path comes back; nothing here composes one.
    const authorized = await send('/api/cms/media/uploads', { contentType: file.type, byteSize: file.size });
    if (authorized.status !== 201) {
      setWorking(false);
      setMessage(messageFor(authorized));
      return;
    }
    const upload = (authorized.body as { upload?: { uploadUrl?: unknown; objectPath?: unknown } } | null)?.upload;
    const uploadUrl = typeof upload?.uploadUrl === 'string' ? upload.uploadUrl : null;
    const objectPath = typeof upload?.objectPath === 'string' ? upload.objectPath : null;
    if (uploadUrl === null || objectPath === null || !CMS_MEDIA_OBJECT_PATH_PATTERN.test(objectPath)) {
      setWorking(false);
      setMessage(copy.failed);
      return;
    }

    // 2. The bytes, straight to the provider. They never pass through this origin.
    try {
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!put.ok) {
        setWorking(false);
        setMessage(copy.uploadFailed);
        return;
      }
    } catch {
      setWorking(false);
      setMessage(copy.uploadFailed);
      return;
    }

    // 3. Confirm, with the path exactly as it was issued.
    const size = await dimensionsOf(file);
    const confirmed = await send('/api/cms/media', {
      objectPath,
      contentType: file.type,
      byteSize: file.size,
      ...(size.width === undefined ? {} : { width: size.width }),
      ...(size.height === undefined ? {} : { height: size.height }),
      altTextEn: altEn.trim() === '' ? null : altEn.trim(),
      altTextAr: altAr.trim() === '' ? null : altAr.trim(),
    });
    setWorking(false);

    if (confirmed.status === 201) {
      if (input.current !== null) input.current.value = '';
      setAltEn('');
      setAltAr('');
      router.refresh();
      return;
    }
    setMessage(messageFor(confirmed));
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <div>
        <label className={LABEL_CLASS} htmlFor="cms-media-file">
          {copy.fileLabel}
        </label>
        <input
          accept={CMS_MEDIA_CONTENT_TYPES.join(',')}
          className={FIELD_CLASS}
          id="cms-media-file"
          name="file"
          ref={input}
          required
          type="file"
        />
        <p className={HINT_CLASS}>{copy.fileHint}</p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="cms-media-alt-en">
            {copy.altTextEnLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="cms-media-alt-en"
            maxLength={CMS_MEDIA_ALT_TEXT_MAX}
            name="altTextEn"
            onChange={(event) => setAltEn(event.target.value)}
            value={altEn}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="cms-media-alt-ar">
            {copy.altTextArLabel}
          </label>
          <input
            className={FIELD_CLASS}
            id="cms-media-alt-ar"
            maxLength={CMS_MEDIA_ALT_TEXT_MAX}
            name="altTextAr"
            onChange={(event) => setAltAr(event.target.value)}
            value={altAr}
          />
        </div>
      </div>
      <p className={HINT_CLASS}>{copy.altTextHint}</p>

      <Problem message={message} />

      <button className={`${BUTTON_CLASS} mt-4`} disabled={working} type="submit">
        {working ? copy.working : copy.submit}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One entry's own controls                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsMediaEntryCopy {
  readonly altTextEnLabel: string;
  readonly altTextArLabel: string;
  readonly save: string;
  readonly saveFailed: string;
  readonly invalid: string;
  readonly preview: string;
  readonly previewFailed: string;
  readonly previewHint: string;
  readonly hidePreview: string;
}

export function CmsMediaEntryControls({
  mediaId,
  altTextEn,
  altTextAr,
  copy,
}: {
  readonly mediaId: string;
  readonly altTextEn: string;
  readonly altTextAr: string;
  readonly copy: CmsMediaEntryCopy;
}) {
  const router = useRouter();
  const [altEn, setAltEn] = useState(altTextEn);
  const [altAr, setAltAr] = useState(altTextAr);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function saveAltText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setWorking(true);
    const outcome = await send(
      '/api/cms/media/alt-text',
      {
        mediaId,
        altTextEn: altEn.trim() === '' ? null : altEn.trim(),
        altTextAr: altAr.trim() === '' ? null : altAr.trim(),
      },
      'PUT',
    );
    setWorking(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(outcome.status === 400 ? copy.invalid : copy.saveFailed);
  }

  /** Fetched when asked for and held in state only. A signed URL is not something to put in a link. */
  async function showPreview(): Promise<void> {
    setMessage(null);
    setWorking(true);
    try {
      const response = await fetch(adminApiPath(`/api/cms/media/${encodeURIComponent(mediaId)}/preview`), {
        credentials: 'same-origin',
      });
      const payload = (await response.json()) as { url?: unknown };
      setWorking(false);
      if (response.status === 200 && typeof payload.url === 'string') {
        setPreviewUrl(payload.url);
        return;
      }
      setMessage(copy.previewFailed);
    } catch {
      setWorking(false);
      setMessage(copy.previewFailed);
    }
  }

  return (
    <div className="mt-4">
      <form onSubmit={saveAltText}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL_CLASS} htmlFor={`alt-en-${mediaId}`}>
              {copy.altTextEnLabel}
            </label>
            <input
              className={FIELD_CLASS}
              id={`alt-en-${mediaId}`}
              maxLength={CMS_MEDIA_ALT_TEXT_MAX}
              name="altTextEn"
              onChange={(event) => setAltEn(event.target.value)}
              value={altEn}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor={`alt-ar-${mediaId}`}>
              {copy.altTextArLabel}
            </label>
            <input
              className={FIELD_CLASS}
              id={`alt-ar-${mediaId}`}
              maxLength={CMS_MEDIA_ALT_TEXT_MAX}
              name="altTextAr"
              onChange={(event) => setAltAr(event.target.value)}
              value={altAr}
            />
          </div>
        </div>
        <button className={`${SECONDARY_CLASS} mt-3`} disabled={working} type="submit">
          {copy.save}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {previewUrl === null ? (
          <button className={SECONDARY_CLASS} disabled={working} onClick={showPreview} type="button">
            {copy.preview}
          </button>
        ) : (
          <button className={SECONDARY_CLASS} onClick={() => setPreviewUrl(null)} type="button">
            {copy.hidePreview}
          </button>
        )}
      </div>

      {previewUrl === null ? null : (
        <div className="mt-3">
          {/* A short-lived signed URL, held in state for this view only. */}
          <img alt={altEn === '' ? '' : altEn} className="max-h-64 rounded-md border border-hairline" src={previewUrl} />
          <p className={HINT_CLASS}>{copy.previewHint}</p>
        </div>
      )}

      <Problem message={message} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Removing an entry                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface CmsMediaRemoveCopy {
  readonly submit: string;
  readonly confirm: string;
  readonly failed: string;
}

/**
 * The delete control, which exists **only inside the server-rendered usage panel**.
 *
 * That is owner decision 5 made structural rather than remembered. This component is not rendered anywhere else, so
 * there is no response that can offer a delete without also carrying the references it would blank — and because the
 * panel is server-rendered, the labels below are not in any payload until an operator has asked to see those
 * references. A client-side reveal would have shipped them to every page view.
 */
export function CmsMediaRemoveForm({
  mediaId,
  copy,
}: {
  readonly mediaId: string;
  readonly copy: CmsMediaRemoveCopy;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!window.confirm(copy.confirm)) return;
    setMessage(null);
    setWorking(true);
    const outcome = await send('/api/cms/media/remove', { mediaId });
    setWorking(false);
    if (outcome.status === 200) {
      router.push(adminPath('/cms/media'));
      router.refresh();
      return;
    }
    setMessage(copy.failed);
  }

  return (
    <form className="mt-3" onSubmit={submit}>
      <Problem message={message} />
      <button className={DANGER_CLASS} disabled={working} type="submit">
        {copy.submit}
      </button>
    </form>
  );
}
