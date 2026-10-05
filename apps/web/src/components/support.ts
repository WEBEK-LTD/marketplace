import {
  SUPPORT_ATTACHMENT_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_TICKET_CATEGORIES,
  OpenSupportTicketResponseSchema,
  SupportAttachmentLinkResponseSchema,
  SupportAttachmentRecordResponseSchema,
  SupportAttachmentUploadResponseSchema,
  SupportMessageMutationResponseSchema,
  SupportTicketClosureResponseSchema,
  type SupportAttachmentContentType,
  type SupportTicketCategory,
} from '@repo/contracts';

/**
 * The requester support surface's logic, with no React and no DOM in it (Phase 7-K).
 *
 * Every decision the pages make is a function here — what may be sent, what is sent, which sentence a
 * refusal becomes, and the three ordered steps of an attachment — so every one of them is testable exactly,
 * without a browser, as a pure function over an injected `fetch`.
 *
 * **The browser chooses nothing about a destination.** {@link authorizeAttachment} sends a type and a size;
 * the path and the URL come back. {@link putBytes} uploads to the URL it was given. {@link recordAttachment}
 * sends back the path the server issued. Nothing here builds a path, a bucket name or a file name, and there
 * is no parameter through which a caller could.
 *
 * **Nothing here sends a status, a priority, an assignee or an author.** Opening a ticket sends a subject, a
 * category and a message; replying sends a body; closing sends nothing at all. `resolved` appears in no
 * function below, because the agent's outcome has no representation on this surface.
 *
 * **The client-side checks are a courtesy.** The lengths are the columns', the type list and the size
 * ceiling are the bucket's, and the database applies all of them again. They exist so somebody choosing a
 * 40 MB photograph is told before it is uploaded rather than after.
 */

/** `support_tickets_subject_length`. */
export const SUPPORT_SUBJECT_MAX_LENGTH = 200;
/** `support_messages_body_length`, which governs the first message and every reply alike. */
export const SUPPORT_BODY_MAX_LENGTH = 8000;

/** The eight categories, for a select. The order is the schema's. */
export const SUPPORT_CATEGORIES = SUPPORT_TICKET_CATEGORIES;

/** The four types the bucket allows, as a browser's `accept` attribute wants them. */
export const SUPPORT_ATTACHMENT_ACCEPT = SUPPORT_ATTACHMENT_CONTENT_TYPES.join(',');

/** How many files one message may carry from this surface. A page's own limit, not a schema rule. */
export const SUPPORT_ATTACHMENTS_PER_MESSAGE = 3;

/**
 * What a refusal is, in the words this surface has.
 *
 * `notFound` covers a ticket that is not the caller's and one that does not exist, because the server
 * answers both identically and a page must not pretend to know more. `closed` is the one refusal with its
 * own remedy. `missing` is a file the storage provider does not have, whose remedy is to attach it again.
 * `throttled` is one of the approved support limits, whose remedy is to wait — and which is deliberately
 * one outcome rather than three, because the server does not say which window was hit and a page must not
 * guess.
 */
export type SupportOutcome<T> =
  | ({ readonly kind: 'ok' } & T)
  | { readonly kind: 'invalid' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'throttled' }
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'unavailable' };

export interface SupportFailureLabels {
  readonly invalid: string;
  readonly notFound: string;
  readonly closed: string;
  readonly missing: string;
  readonly throttled: string;
  readonly signedOut: string;
  readonly unavailable: string;
}

/** The one place a refusal becomes a sentence. Nothing here interpolates a value from the server. */
export function supportFailureMessage(
  outcome: Exclude<SupportOutcome<unknown>['kind'], 'ok'>,
  labels: SupportFailureLabels,
): string {
  switch (outcome) {
    case 'invalid':
      return labels.invalid;
    case 'notFound':
      return labels.notFound;
    case 'closed':
      return labels.closed;
    case 'missing':
      return labels.missing;
    case 'throttled':
      return labels.throttled;
    case 'signedOut':
      return labels.signedOut;
    default:
      return labels.unavailable;
  }
}

/** Text a person typed, trimmed and bounded by the column that will hold it. */
export type TextCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: 'empty' | 'too_long' };

export function prepareText(value: string, maximum: number): TextCheck {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  if (trimmed.length > maximum) return { ok: false, problem: 'too_long' };
  return { ok: true, value: trimmed };
}

/** Whether a category is one of the eight. A `select` cannot offer another, and this refuses one anyway. */
export function isSupportCategory(value: string): value is SupportTicketCategory {
  return (SUPPORT_TICKET_CATEGORIES as readonly string[]).includes(value);
}

/** What somebody picked, reduced to the two things that decide whether it can be uploaded. */
export interface ChosenFile {
  readonly type: string;
  readonly size: number;
}

export type FileCheck =
  | { readonly ok: true; readonly contentType: SupportAttachmentContentType }
  | { readonly ok: false; readonly problem: 'type' | 'size' };

export function checkChosenFile(file: ChosenFile): FileCheck {
  if (!(SUPPORT_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, problem: 'type' };
  }
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, problem: 'size' };
  }
  return { ok: true, contentType: file.type as SupportAttachmentContentType };
}

/* ------------------------------------------------------------------------------------------------ */

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

async function send(
  path: string,
  body: unknown,
  fetcher: typeof fetch,
  method: 'GET' | 'POST' = 'POST',
): Promise<RawResponse | null> {
  try {
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text().catch(() => '') };
  } catch {
    return null;
  }
}

/**
 * Turns one response this origin gave into an outcome.
 *
 * The problem code is read where there is one, because two refusals share a status: a closed ticket and a
 * file the provider does not have are both things a person can act on, and they are different actions.
 */
function refusal(status: number, text: string): Exclude<SupportOutcome<never>, { kind: 'ok' }> {
  if (status === 401) return { kind: 'signedOut' };
  if (status === 429) return { kind: 'throttled' };
  if (status === 409) return { kind: 'closed' };
  if (status === 404) {
    return code(text) === 'SUPPORT_ATTACHMENT_OBJECT_MISSING' ? { kind: 'missing' } : { kind: 'notFound' };
  }
  if (status === 400 || status === 403) return { kind: 'invalid' };
  return { kind: 'unavailable' };
}

function code(text: string): string | null {
  try {
    const body = JSON.parse(text) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

function parsed<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  text: string,
): T | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The five writes and the one read                                                                  */
/* ------------------------------------------------------------------------------------------------ */

/** Opens one ticket. The response names the ticket and its first message, so a file can follow. */
export async function openSupportTicket(
  input: { subject: string; category: SupportTicketCategory; body: string },
  fetcher: typeof fetch = fetch,
  path = '/api/support/tickets',
): Promise<SupportOutcome<{ ticketId: string; messageId: string }>> {
  const response = await send(path, input, fetcher);
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  const data = parsed(OpenSupportTicketResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  return { kind: 'ok', ticketId: data.ticketId, messageId: data.messageId };
}

/** Replies on one's own ticket. The response names the message, so a file can follow. */
export async function postSupportMessage(
  ticketId: string,
  body: string,
  fetcher: typeof fetch = fetch,
  prefix = '/api/support/tickets',
): Promise<SupportOutcome<{ messageId: string }>> {
  const response = await send(
    `${prefix}/${encodeURIComponent(ticketId)}/messages`,
    { body },
    fetcher,
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  const data = parsed(SupportMessageMutationResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  return { kind: 'ok', messageId: data.messageId };
}

/** Closes one's own ticket. It sends no body, and there is no status to send. */
export async function closeSupportTicket(
  ticketId: string,
  fetcher: typeof fetch = fetch,
  prefix = '/api/support/tickets',
): Promise<SupportOutcome<{ status: string }>> {
  const response = await send(
    `${prefix}/${encodeURIComponent(ticketId)}/close`,
    undefined,
    fetcher,
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 200) return refusal(response.status, response.text);

  const data = parsed(SupportTicketClosureResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  return { kind: 'ok', status: data.status };
}

/** Step one of an attachment: ask this origin for a target. */
export async function authorizeSupportAttachment(
  ticketId: string,
  messageId: string,
  file: ChosenFile,
  fetcher: typeof fetch = fetch,
  prefix = '/api/support/tickets',
): Promise<SupportOutcome<{ uploadUrl: string; objectPath: string }>> {
  const checked = checkChosenFile(file);
  if (!checked.ok) return { kind: 'invalid' };

  const response = await send(
    `${prefix}/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}/attachments/uploads`,
    { contentType: checked.contentType, byteSize: file.size },
    fetcher,
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  const data = parsed(SupportAttachmentUploadResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  // Projected field by field: the two values the next steps need, and nothing else the contract carries.
  return { kind: 'ok', uploadUrl: data.upload.uploadUrl, objectPath: data.upload.objectPath };
}

/**
 * Step two: the bytes, straight to the signed URL.
 *
 * `credentials: 'omit'`, so no cookie of this site's is ever attached to a storage request — the URL is the
 * authorization, and it is the only one this request carries.
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

/** Step three: tell this origin where the file went, at the path it issued. */
export async function recordSupportAttachment(
  ticketId: string,
  messageId: string,
  input: { objectPath: string; originalFilename: string; contentType: string; byteSize: number },
  fetcher: typeof fetch = fetch,
  prefix = '/api/support/tickets',
): Promise<SupportOutcome<{ attachmentCount: number }>> {
  const response = await send(
    `${prefix}/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}/attachments`,
    input,
    fetcher,
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  const data = parsed(SupportAttachmentRecordResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  return { kind: 'ok', attachmentCount: data.attachmentCount };
}

/**
 * All three attachment steps, in order, with the signed URL confined to this call.
 *
 * Nothing is reported as attached until the server has confirmed it: a failed PUT answers `unavailable` and
 * the confirmation is never attempted, so what a page displays can only ever come from the server.
 */
export async function runSupportAttachmentUpload(
  ticketId: string,
  messageId: string,
  file: ChosenFile & { readonly body: Blob | ArrayBuffer; readonly name: string },
  fetchers: { readonly origin?: typeof fetch; readonly storage?: typeof fetch } = {},
): Promise<SupportOutcome<{ attachmentCount: number }>> {
  const checked = checkChosenFile(file);
  if (!checked.ok) return { kind: 'invalid' };

  const authorized = await authorizeSupportAttachment(ticketId, messageId, file, fetchers.origin);
  if (authorized.kind !== 'ok') return authorized;

  const uploaded = await putBytes(
    authorized.uploadUrl,
    file.body,
    checked.contentType,
    fetchers.storage,
  );
  if (!uploaded) return { kind: 'unavailable' };

  return await recordSupportAttachment(
    ticketId,
    messageId,
    {
      objectPath: authorized.objectPath,
      originalFilename: file.name,
      contentType: checked.contentType,
      byteSize: file.size,
    },
    fetchers.origin,
  );
}

/**
 * A short-lived link to one file.
 *
 * Fetched when somebody asks for it rather than rendered into the page, because it stops working within
 * minutes. The identifier is an attachment's; there is no path in the request and none in the answer.
 */
export async function supportAttachmentLink(
  ticketId: string,
  attachmentId: string,
  fetcher: typeof fetch = fetch,
  prefix = '/api/support/tickets',
): Promise<SupportOutcome<{ url: string }>> {
  const response = await send(
    `${prefix}/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/link`,
    undefined,
    fetcher,
    'GET',
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 200) return refusal(response.status, response.text);

  const data = parsed(SupportAttachmentLinkResponseSchema, response.text);
  if (data === null) return { kind: 'unavailable' };
  return { kind: 'ok', url: data.url };
}
