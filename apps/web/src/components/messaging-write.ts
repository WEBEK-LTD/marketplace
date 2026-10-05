import { MESSAGE_BODY_MAX_LENGTH } from '@repo/contracts';

/**
 * The messaging write logic, separated from the components that render it (Phase 5-E).
 *
 * The composer and the controls are `'use client'` components, and this repository's web suite renders
 * components to static markup rather than driving them — there is no DOM harness here. So every rule that
 * a test needs to pin lives in this module as a plain function: what counts as a sendable body, which
 * sentence a refusal becomes, which route an action calls and with what body. The components hold state
 * and call these; the rules are tested directly.
 *
 * Two invariants this module exists to keep:
 *
 * **Nothing is reported as sent until the server says so.** `sendMessage` resolves to a discriminated
 * result, and the only branch that yields `ok` is a 201 whose body parses. A network failure, an
 * unexpected status and a malformed body are all refusals, never an optimistic success.
 *
 * **The body is trimmed exactly once, here.** The same `btrim`-then-measure rule the database enforces is
 * applied before the request leaves, so a whitespace-only draft never becomes a request at all, and the
 * length the person is warned about is the length that will be stored.
 */

export { MESSAGE_BODY_MAX_LENGTH };

/** Every write this increment performs, as the path it addresses on this origin. */
export const MESSAGING_WRITE_ROUTES = {
  startConversation: '/api/messaging/conversations',
  sendMessage: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/messages`,
  markRead: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/read`,
  setMuted: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/muted`,
  leave: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/membership`,
  close: (conversationId: string) =>
    `/api/messaging/conversations/${encodeURIComponent(conversationId)}/closed`,
  report: '/api/messaging/reports',
} as const;

/** Why a draft cannot be sent, or `null` when it can. */
export type DraftProblem = 'empty' | 'too_long';

/**
 * The trimmed body, or the reason it is not sendable.
 *
 * `trim()` is the browser-side counterpart of the `btrim` the send function applies: a draft of spaces and
 * newlines is empty, and the 5000 limit is measured after trimming, exactly as the database measures it.
 */
export function prepareBody(draft: string): { body: string } | { problem: DraftProblem } {
  const body = draft.trim();
  if (body === '') return { problem: 'empty' };
  if (body.length > MESSAGE_BODY_MAX_LENGTH) return { problem: 'too_long' };
  return { body };
}

/**
 * What a write can come back as.
 *
 * `refused` carries the upstream status and, when the problem body had one, its code — the two things a
 * sentence is chosen from. Nothing else from a refusal body is kept: the API's `detail` is already the
 * approved wording for an API caller, but this surface has its own translated copy, and rendering an
 * upstream sentence would put untranslated text on an Arabic page.
 */
export type WriteResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string | null }
  | { readonly kind: 'unavailable' };

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * One same-origin write.
 *
 * `credentials: 'same-origin'` is what carries the session cookie the BFF reads; no token is ever held in
 * a variable here. A body is sent only when there is one, so the routes that take none are called with
 * none rather than with `null` — which the contract would refuse.
 */
async function write(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  fetcher: Fetcher,
): Promise<{ status: number; text: string } | null> {
  try {
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

/** The `code` of an RFC 9457 body, when the refusal carried one. */
function problemCode(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code !== '' ? code : null;
  } catch {
    return null;
  }
}

/** Reads one expected success status and parses the body, or refuses. */
function resultOf<T>(
  raw: { status: number; text: string } | null,
  expected: number,
  read: (payload: unknown) => T | null,
): WriteResult<T> {
  if (raw === null) return { kind: 'unavailable' };
  if (raw.status !== expected) {
    return { kind: 'refused', status: raw.status, code: problemCode(raw.text) };
  }
  let parsed: T | null;
  try {
    parsed = read(JSON.parse(raw.text));
  } catch {
    return { kind: 'unavailable' };
  }
  return parsed === null ? { kind: 'unavailable' } : { kind: 'ok', data: parsed };
}

function readString(payload: unknown, field: string): string | null {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readBoolean(payload: unknown, field: string): boolean | null {
  const value = (payload as Record<string, unknown> | null)?.[field];
  return typeof value === 'boolean' ? value : null;
}

/** Starts a conversation from a listing, or resolves to the one already open. */
export async function startListingConversation(
  listingId: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ conversationId: string }>> {
  const raw = await write(
    MESSAGING_WRITE_ROUTES.startConversation,
    'POST',
    { subjectType: 'listing', listingId },
    fetcher,
  );
  return resultOf(raw, 200, (payload) => {
    const conversationId = readString(payload, 'conversationId');
    return conversationId === null ? null : { conversationId };
  });
}

/**
 * Starts a direct conversation with a publicly visible seller, or resolves to the open one.
 *
 * The seller is named by the slug already in the profile page's own URL. There is no user id to send and
 * the browser is never given one — the resolution happens inside the database.
 */
export async function startDirectConversation(
  sellerSlug: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ conversationId: string }>> {
  const raw = await write(
    MESSAGING_WRITE_ROUTES.startConversation,
    'POST',
    { subjectType: 'direct', sellerSlug },
    fetcher,
  );
  return resultOf(raw, 200, (payload) => {
    const conversationId = readString(payload, 'conversationId');
    return conversationId === null ? null : { conversationId };
  });
}

/** Sends one text message. Resolves to `ok` only on a 201 whose body carries the stored message. */
export async function sendMessage(
  conversationId: string,
  body: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ seq: string }>> {
  const raw = await write(MESSAGING_WRITE_ROUTES.sendMessage(conversationId), 'POST', { body }, fetcher);
  return resultOf(raw, 201, (payload) => {
    const message = (payload as { message?: unknown } | null)?.message;
    const seq = readString(message, 'seq');
    return seq === null ? null : { seq };
  });
}

/** Moves the caller's own read marker. Monotonic server-side; this only names a sequence. */
export async function markRead(
  conversationId: string,
  seq: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ lastReadSeq: string | null }>> {
  const raw = await write(MESSAGING_WRITE_ROUTES.markRead(conversationId), 'PUT', { seq }, fetcher);
  return resultOf(raw, 200, (payload) => {
    const value = (payload as Record<string, unknown> | null)?.['lastReadSeq'];
    if (value === null) return { lastReadSeq: null };
    return typeof value === 'string' ? { lastReadSeq: value } : null;
  });
}

/** Sets the caller's own mute flag. Muting changes notification intent, never readability. */
export async function setMuted(
  conversationId: string,
  isMuted: boolean,
  fetcher: Fetcher,
): Promise<WriteResult<{ isMuted: boolean }>> {
  const raw = await write(MESSAGING_WRITE_ROUTES.setMuted(conversationId), 'PUT', { isMuted }, fetcher);
  return resultOf(raw, 200, (payload) => {
    const parsed = readBoolean(payload, 'isMuted');
    return parsed === null ? null : { isMuted: parsed };
  });
}

/** The caller leaves. History stays readable; sending does not. */
export async function leaveConversation(
  conversationId: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ membershipState: 'left' }>> {
  const raw = await write(MESSAGING_WRITE_ROUTES.leave(conversationId), 'DELETE', undefined, fetcher);
  return resultOf(raw, 200, (payload) =>
    readString(payload, 'membershipState') === 'left' ? { membershipState: 'left' } : null,
  );
}

/** Closes the conversation for everyone in it. Idempotent, and there is no reopen. */
export async function closeConversation(
  conversationId: string,
  fetcher: Fetcher,
): Promise<WriteResult<{ isClosed: true }>> {
  const raw = await write(MESSAGING_WRITE_ROUTES.close(conversationId), 'PUT', undefined, fetcher);
  return resultOf(raw, 200, (payload) =>
    readBoolean(payload, 'isClosed') === true ? { isClosed: true } : null,
  );
}

/** The sentences a refusal can become. Every field is required so none can be forgotten. */
export interface WriteFailureLabels {
  /** 400 — the draft itself was refused. */
  readonly invalid: string;
  /** 401 — the session is no longer usable. */
  readonly signedOut: string;
  /** 404 — not theirs, or gone. Identical wording for both, as the API is. */
  readonly unavailable: string;
  /** 409 — closed. */
  readonly closed: string;
  /** 409 — blocked, or a seller who cannot be contacted. */
  readonly blocked: string;
  /** 429 — a rate limit. */
  readonly throttled: string;
  /** Anything else, including a request that never left. */
  readonly failed: string;
}

/**
 * One status, one sentence.
 *
 * 409 is two different situations — a closed conversation and a refused pair — and the API distinguishes
 * them by problem code, so this takes the code when there is one. Anything unrecognised falls to the
 * generic sentence rather than to the most specific one: a wrong guess about *why* is worse than none.
 */
export function writeFailureMessage(
  status: number,
  code: string | null,
  labels: WriteFailureLabels,
): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.signedOut;
  if (status === 404) return labels.unavailable;
  if (status === 429) return labels.throttled;
  if (status === 409) {
    if (code === 'MESSAGING_CONVERSATION_CLOSED') return labels.closed;
    if (code === 'MESSAGING_BLOCKED' || code === 'MESSAGING_SELLER_NOT_CONTACTABLE') return labels.blocked;
    return labels.failed;
  }
  return labels.failed;
}

/**
 * Whether the composer may be used at all.
 *
 * Closed and left are separate reasons with separate sentences, and both disable it. The composer is not
 * hidden when it is unusable: a thread whose input vanished reads as a broken page, where a disabled one
 * with a reason reads as a rule.
 */
export function composerState(input: {
  readonly isClosed: boolean;
  readonly hasLeft: boolean;
}): 'open' | 'closed' | 'left' {
  if (input.isClosed) return 'closed';
  if (input.hasLeft) return 'left';
  return 'open';
}

/** What a report can be about. Both are subject types the platform's reporting already knows. */
export type ReportSubject =
  | { readonly kind: 'message'; readonly messageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string };

/**
 * Files a report about a message or a conversation (Phase 5-H).
 *
 * The reason is `other`, the existing vocabulary's value for "not specified". Messaging asks the reporter
 * for no reason and invents no taxonomy of its own, so there is nothing else honest to send — and no
 * free-text field, which is what keeps the message itself out of the report.
 *
 * A repeat is a success, not an error: the platform's reporting lands a second submission on the report
 * already open and answers with the same id, so the surface says the same thing either way.
 */
export async function fileReport(
  subject: ReportSubject,
  fetcher: Fetcher,
): Promise<WriteResult<{ reportId: string }>> {
  const raw = await write(
    MESSAGING_WRITE_ROUTES.report,
    'POST',
    subject.kind === 'message'
      ? { subjectType: 'message', subjectId: subject.messageId, reasonCode: 'other' }
      : { subjectType: 'conversation', subjectId: subject.conversationId, reasonCode: 'other' },
    fetcher,
  );
  return resultOf(raw, 200, (payload) => {
    const reportId = readString(payload, 'reportId');
    return reportId === null ? null : { reportId };
  });
}
