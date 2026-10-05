import {
  SELLER_MEDIA_CONTENT_TYPES,
  SELLER_MEDIA_MAX_BYTES,
  SellerMediaAttachResponseSchema,
  SellerMediaUploadResponseSchema,
  type SellerMediaKind,
} from '@repo/contracts';

/**
 * The media upload's logic, with no React and no DOM in it (Phase 6-E).
 *
 * The flow is the spec's three steps, and each one is a function here: authorize, put the bytes, confirm. All
 * three are decidable without a browser — which type and size are acceptable, what is sent, which sentence a
 * refusal becomes — so all three are tested exactly, as pure functions over an injected `fetch`.
 *
 * **The browser chooses nothing about the destination.** {@link authorizeUpload} sends a kind, a type and a
 * size; the path and the URL come back. {@link putBytes} uploads to the URL it was given and to no URL it
 * composed. {@link confirmUpload} sends back the path the server issued. At no point does this module build a
 * path, a bucket name or a file name, and there is no parameter anywhere below through which a caller could.
 *
 * **The client-side checks are a courtesy.** The type list and the size ceiling are the contract's, which are
 * the bucket's; the database applies them again, and a file that passes here can still be refused there. They
 * exist so somebody choosing a 40 MB photograph is told before it is uploaded, not after.
 *
 * **The signed URL is used once and kept nowhere.** It is not stored, not logged, not put in a data attribute
 * and not returned to the caller of {@link runUpload} — it lives inside one function call.
 */

/** The four types the bucket allows, as a browser's `accept` attribute wants them. */
export const MEDIA_ACCEPT = SELLER_MEDIA_CONTENT_TYPES.join(',');

export type MediaCheck =
  | { readonly ok: true; readonly contentType: (typeof SELLER_MEDIA_CONTENT_TYPES)[number] }
  | { readonly ok: false; readonly reason: 'missing' | 'type' | 'size' };

/** What the person picked, reduced to the three things that decide whether it can be uploaded. */
export interface ChosenFile {
  readonly type: string;
  readonly size: number;
}

/** Whether this file could be uploaded at all, and why not when it could not. */
export function checkChosenFile(file: ChosenFile | null): MediaCheck {
  if (file === null) return { ok: false, reason: 'missing' };
  const allowed = SELLER_MEDIA_CONTENT_TYPES.find((type) => type === file.type);
  if (allowed === undefined) return { ok: false, reason: 'type' };
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > SELLER_MEDIA_MAX_BYTES) {
    return { ok: false, reason: 'size' };
  }
  return { ok: true, contentType: allowed };
}

/** The authorized target, narrowed to what the next two steps need. Never stored, never rendered. */
export interface UploadTarget {
  readonly uploadUrl: string;
  readonly objectPath: string;
}

export type UploadOutcome =
  | { readonly kind: 'uploaded'; readonly hasLogo: boolean; readonly hasBanner: boolean }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** The problem code, if the body is a problem document. Anything else reads as no code at all. */
function problemCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/** Maps a refused BFF response onto the outcomes the form can render. */
function refusal(status: number, text: string): UploadOutcome {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 409) {
    return problemCode(text) === 'SELLER_PROFILE_NOT_EDITABLE'
      ? { kind: 'not_editable' }
      : { kind: 'unavailable' };
  }
  if (status === 400) return { kind: 'invalid' };
  // 404, 429 and anything else: nothing the person can fix by changing a field.
  return { kind: 'unavailable' };
}

/** Step one: ask this origin for a target. Returns the target, or the outcome to render instead. */
export async function authorizeUpload(
  mediaKind: SellerMediaKind,
  file: ChosenFile,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/media/uploads',
): Promise<{ readonly ok: true; readonly target: UploadTarget } | { readonly ok: false; readonly outcome: UploadOutcome }> {
  const checked = checkChosenFile(file);
  if (!checked.ok) return { ok: false, outcome: { kind: 'invalid' } };

  let response: Response;
  try {
    response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaKind, contentType: checked.contentType, byteSize: file.size }),
    });
  } catch {
    return { ok: false, outcome: { kind: 'unavailable' } };
  }

  const text = await response.text().catch(() => '');
  if (response.status !== 201) return { ok: false, outcome: refusal(response.status, text) };

  let parsed: ReturnType<typeof SellerMediaUploadResponseSchema.safeParse>;
  try {
    parsed = SellerMediaUploadResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { ok: false, outcome: { kind: 'unavailable' } };
  }
  if (!parsed.success) return { ok: false, outcome: { kind: 'unavailable' } };

  // Projected field by field: the two values the next steps need, and nothing else the contract carries.
  return {
    ok: true,
    target: { uploadUrl: parsed.data.upload.uploadUrl, objectPath: parsed.data.upload.objectPath },
  };
}

/**
 * Step two: the bytes, straight to the signed URL.
 *
 * The only request in this project that does not go to this origin, and the only one that carries no session:
 * the URL is the authorization. `credentials: 'omit'` says so explicitly, so no cookie of this site's is ever
 * attached to a storage request.
 */
export async function putBytes(
  uploadUrl: string,
  body: Blob | ArrayBuffer,
  contentType: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: { 'content-type': contentType },
      body: body as BodyInit,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Step three: tell this origin where the file went. */
export async function confirmUpload(
  mediaKind: SellerMediaKind,
  objectPath: string,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/media',
): Promise<UploadOutcome> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaKind, objectPath }),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');
  if (response.status !== 200) return refusal(response.status, text);

  let parsed: ReturnType<typeof SellerMediaAttachResponseSchema.safeParse>;
  try {
    parsed = SellerMediaAttachResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  if (!parsed.success) return { kind: 'unavailable' };
  return { kind: 'uploaded', hasLogo: parsed.data.media.hasLogo, hasBanner: parsed.data.media.hasBanner };
}

/**
 * All three steps, in order, with the signed URL confined to this call.
 *
 * Nothing is reported as uploaded until the server has confirmed it: a failed PUT answers `unavailable` and the
 * confirmation is never attempted, so the displayed state can only ever come from the server.
 */
export async function runUpload(
  mediaKind: SellerMediaKind,
  file: ChosenFile & { readonly body: Blob | ArrayBuffer },
  fetchers: { readonly origin?: typeof fetch; readonly storage?: typeof fetch } = {},
): Promise<UploadOutcome> {
  const authorized = await authorizeUpload(mediaKind, file, fetchers.origin);
  if (!authorized.ok) return authorized.outcome;

  const sent = await putBytes(authorized.target.uploadUrl, file.body, file.type, fetchers.storage);
  if (!sent) return { kind: 'unavailable' };

  return confirmUpload(mediaKind, authorized.target.objectPath, fetchers.origin);
}
