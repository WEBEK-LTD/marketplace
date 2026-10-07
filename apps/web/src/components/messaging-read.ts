import type { RenderableConversation, RenderableMessage } from './messaging-views';

/**
 * The browser's own reads of the messaging surface (Phase 5-F).
 *
 * Three GETs against the already-shipped BFF routes and nothing else. There is no new route here, no
 * cursor construction, and no mutation of any kind: this module cannot send a message, move a read
 * marker, mute, leave or close, because it contains no function that does.
 *
 * **Cursors stay opaque.** The inbox reader takes the cursor it was given and appends it as a query
 * parameter. It never parses one, never inspects one and never builds one — the only cursors in play are
 * strings the API issued.
 *
 * **Responses are narrowed, not trusted.** Each answer is validated field by field and rebuilt into the
 * render types, so a drifted body becomes a clean failure rather than a half-rendered row. Validation is
 * hand-written rather than a schema import to keep the browser bundle free of one.
 *
 * **Identifiers are dropped on the way in.** A polled message carries `senderUserId`; nothing on the page
 * shows it, and the render types have nowhere to put it, so it stops here.
 */

export type ReadResult<T> = { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'failed' };

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export const MESSAGING_READ_ROUTES = {
  inbox: '/api/messaging/conversations',
  messages: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/messages`,
  unreadCount: '/api/messaging/unread-count',
} as const;

/** One same-origin GET. The session travels as the cookie the browser sends on its own. */
async function read(path: string, fetcher: Fetcher): Promise<unknown | null> {
  try {
    const response = await fetcher(path, { method: 'GET', credentials: 'same-origin' });
    if (response.status !== 200) return null;
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function digits(value: unknown): string | null {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

const SUBJECT_TYPES = ['listing', 'direct', 'service_request', 'order'] as const;
const MESSAGE_TYPES = ['text', 'system', 'reference'] as const;
const MEMBERSHIP_STATES = ['active', 'left'] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** One message, reduced to what a thread renders. Returns null if any field is not what it must be. */
export function toRenderableMessage(value: unknown): RenderableMessage | null {
  const row = record(value);
  if (row === null) return null;

  const id = text(row['id']);
  const seq = digits(row['seq']);
  const messageType = oneOf(row['messageType'], MESSAGE_TYPES);
  const isOwnMessage = flag(row['isOwnMessage']);
  const createdAt = text(row['createdAt']);
  const body = nullableText(row['body']);
  if (id === null || seq === null || messageType === null || isOwnMessage === null) return null;
  if (createdAt === null || body === undefined) return null;

  // `senderUserId` is present in the response and deliberately not carried across.
  return { id, seq, messageType, isOwnMessage, createdAt, body, attachments: attachmentsOf(row) };
}

/** The four types 0104 permits. Hand-written for the same reason the rest of this file is: no schema import. */
const ATTACHMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

/**
 * The attachments on one polled message (0104).
 *
 * A row this parser cannot read contributes nothing rather than failing the whole message: losing an
 * attachment from a poll is recoverable by reloading, and dropping the message it hung from would take the
 * text with it. An absent `attachments` field is an empty list, so a response from before 0104 — or one that
 * lost the field — renders as a message with no files rather than as a parse failure.
 */
function attachmentsOf(row: Record<string, unknown>): RenderableMessage['attachments'] {
  const raw = row['attachments'];
  if (!Array.isArray(raw)) return [];

  const parsed: Array<RenderableMessage['attachments'][number]> = [];
  for (const entry of raw) {
    const item = record(entry);
    if (item === null) continue;
    const id = text(item['id']);
    const contentType = oneOf(item['contentType'], ATTACHMENT_CONTENT_TYPES);
    const byteSize = digits(item['byteSize']);
    if (id === null || contentType === null || byteSize === null) continue;
    parsed.push({ id, contentType, byteSize });
  }
  return parsed;
}

/** One conversation, reduced to what a row renders. */
export function toRenderableConversation(value: unknown): RenderableConversation | null {
  const row = record(value);
  if (row === null) return null;

  const conversationId = text(row['conversationId']);
  const subjectType = oneOf(row['subjectType'], SUBJECT_TYPES);
  const membershipState = oneOf(row['membershipState'], MEMBERSHIP_STATES);
  const isMuted = flag(row['isMuted']);
  const isClosed = flag(row['isClosed']);
  const unreadCount = wholeNumber(row['unreadCount']);
  const listingTitleSnapshot = nullableText(row['listingTitleSnapshot']);
  const lastMessageAt = nullableText(row['lastMessageAt']);
  const lastMessageBody = nullableText(row['lastMessageBody']);
  if (conversationId === null || subjectType === null || membershipState === null) return null;
  if (isMuted === null || isClosed === null || unreadCount === null) return null;
  if (listingTitleSnapshot === undefined || lastMessageAt === undefined) return null;
  if (lastMessageBody === undefined) return null;

  return {
    conversationId,
    subjectType,
    listingTitleSnapshot,
    membershipState,
    isMuted,
    isClosed,
    unreadCount,
    lastMessageAt,
    lastMessageBody,
  };
}

function items(value: unknown): unknown[] | null {
  const body = record(value);
  const list = body?.['items'];
  return Array.isArray(list) ? list : null;
}

export interface InboxPage {
  readonly rows: RenderableConversation[];
  /** The API's own next cursor, carried as text. */
  readonly nextCursor: string | null;
}

/**
 * The inbox page the reader is currently looking at.
 *
 * The cursor is the one the page was rendered with — the API's own opaque string, passed straight back so
 * that polling refreshes *this* page rather than jumping the reader to the first one.
 */
export async function fetchInboxPage(cursor: string | null, fetcher: Fetcher): Promise<ReadResult<InboxPage>> {
  const path =
    cursor === null
      ? MESSAGING_READ_ROUTES.inbox
      : `${MESSAGING_READ_ROUTES.inbox}?cursor=${encodeURIComponent(cursor)}`;
  const payload = await read(path, fetcher);
  const list = items(payload);
  if (list === null) return { kind: 'failed' };

  const rows: RenderableConversation[] = [];
  for (const entry of list) {
    const row = toRenderableConversation(entry);
    if (row === null) return { kind: 'failed' };
    rows.push(row);
  }

  const next = record(payload)?.['nextCursor'];
  if (next !== null && typeof next !== 'string') return { kind: 'failed' };
  return { kind: 'ok', data: { rows, nextCursor: next === null ? null : next } };
}

/**
 * The newest page of one conversation.
 *
 * No cursor: the catch-up asks for the latest page, which is what the existing backward-paginated reader
 * returns when asked for nothing. There is no "since" parameter invented here, and the caller merges the
 * answer into what it already has rather than replacing it.
 */
export async function fetchLatestMessages(
  conversationId: string,
  fetcher: Fetcher,
): Promise<ReadResult<RenderableMessage[]>> {
  const payload = await read(MESSAGING_READ_ROUTES.messages(conversationId), fetcher);
  const list = items(payload);
  if (list === null) return { kind: 'failed' };

  const messages: RenderableMessage[] = [];
  for (const entry of list) {
    const message = toRenderableMessage(entry);
    if (message === null) return { kind: 'failed' };
    messages.push(message);
  }
  return { kind: 'ok', data: messages };
}

/** The global unread count. A failure is a failure; it never becomes a zero. */
export async function fetchUnreadCount(fetcher: Fetcher): Promise<ReadResult<number>> {
  const payload = await read(MESSAGING_READ_ROUTES.unreadCount, fetcher);
  const count = wholeNumber(record(payload)?.['unreadCount']);
  return count === null ? { kind: 'failed' } : { kind: 'ok', data: count };
}
