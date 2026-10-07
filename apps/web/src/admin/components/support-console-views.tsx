import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  SupportAssignedResponse,
  SupportConsoleMessagesResponse,
  SupportConsoleTicket,
  SupportInternalNotesResponse,
  SupportQueueResponse,
} from '@repo/contracts';
import {
  readSupportAssigned,
  readSupportConsoleMessages,
  readSupportConsoleTicket,
  readSupportInternalNotes,
  readSupportQueue,
  type SupportConsoleResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import {
  SupportAssignmentForm,
  SupportDecisionForm,
  SupportNoteForm,
  SupportReplyForm,
} from './support-console-forms';
import { SupportAttachmentButton } from './support-attachment-button';
import { adminPath } from '../paths';

/**
 * The support agent console's screens (Phase 7-L).
 *
 * **Every one is a server component rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the page
 * function — so a refused request performs no read at all.
 *
 * **The internal notes section is a separate read, and it is absent rather than empty.** It comes from its own
 * endpoint, which the API refuses to anybody without `support.ticket.read`; a caller it refuses gets
 * `notFound` and this file renders **no heading at all**, rather than an empty "Internal notes" section that
 * would itself say there was something they could not see.
 *
 * **The controls are shipped only where they apply.** A queued ticket ships the words for claiming; a ticket
 * the caller holds ships the reply box, the note box, the release control and the decision control; a closed
 * one ships none of them. Words for a control that is not on the screen are not in the payload, which is why
 * each form's copy is assembled next to the branch that renders it rather than once at the top.
 *
 * **No colleague is ever named.** The contracts carry `isMine`, `isAssigned` and `isOwnNote` and no account
 * identifier at all, so there is nothing in this file that could render who else is working on something —
 * only whether somebody is.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, a ticket that is
 * not the caller's to see, and a closed ticket each have their own rendering, because somebody who cannot tell
 * "nothing is waiting" from "we could not ask" will eventually act on the wrong one.
 */

type ConsoleTranslate = Awaited<ReturnType<typeof getTranslations<'SupportConsole'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

/** A size in whole kilobytes, or null. Never a byte count in a sentence. */
function kilobytes(value: string | null): string | null {
  if (value === null) return null;
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function refusal(
  result: SupportConsoleResult<unknown>,
  t: ConsoleTranslate,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'notFound') {
    return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  }
  if (result.kind === 'invalid') {
    return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
  }
  return <Notice title={shell('unavailableTitle')} body={shell('unavailableBody')} />;
}

function Notice({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{body}</p>
    </div>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function StatusBadge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The two lists                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

function TicketRow({
  ticket,
  t,
  showOutcome,
}: {
  readonly ticket: SupportQueueResponse['items'][number] & {
    readonly resolvedAt?: string | null;
    readonly closedAt?: string | null;
  };
  readonly t: ConsoleTranslate;
  readonly showOutcome: boolean;
}) {
  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-neutral-900">
            <Link href={adminPath(`/support/${ticket.id}`)} className="underline underline-offset-4">
              {ticket.subject}
            </Link>
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            <span className="text-xs text-neutral-600">{t('requester')}: </span>
            {ticket.requesterName ?? t('requesterUnknown')}
            {ticket.reference !== null && (
              <>
                {' · '}
                <span className="font-mono text-xs">{ticket.reference}</span>
              </>
            )}
          </p>
        </div>
        <StatusBadge label={t(`status.${ticket.status}`)} />
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <Cell label={t('category')} value={t(`category.${ticket.category}`)} />
        {/*
          Read, never ranked: the queue is ordered oldest first, because the schema's priority column is text
          and ordering it would express nothing. It is shown so a colleague can judge for themselves.
        */}
        <Cell label={t('priority')} value={t(`priority.${ticket.priority}`)} />
        <Cell label={t('openedAt')} value={minute(ticket.createdAt)} />
        {ticket.lastMessageAt !== null && (
          <Cell label={t('lastActivity')} value={minute(ticket.lastMessageAt)} />
        )}
        <Cell label={t('messages')} value={String(ticket.messageCount)} />
        {ticket.attachmentCount > 0 && (
          <Cell label={t('files')} value={String(ticket.attachmentCount)} />
        )}
        {ticket.noteCount > 0 && <Cell label={t('notes')} value={String(ticket.noteCount)} />}
        {showOutcome && ticket.resolvedAt != null && (
          <Cell label={t('resolvedAt')} value={minute(ticket.resolvedAt)} />
        )}
        {showOutcome && ticket.closedAt != null && (
          <Cell label={t('closedAt')} value={minute(ticket.closedAt)} />
        )}
      </dl>

      <p className="mt-3 text-sm">
        <Link href={adminPath(`/support/${ticket.id}`)} className="underline underline-offset-4">
          {t('open')}
        </Link>
      </p>
    </li>
  );
}

/** The shared queue: tickets nobody has claimed, oldest first. */
export async function SupportQueue({ cursor }: { readonly cursor: string | null }) {
  const t = await getTranslations('SupportConsole');
  const result = await readSupportQueue({ cursor }, { cookieHeader: await currentCookieHeader() });

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const page = (result as { kind: 'ok'; data: SupportQueueResponse }).data;

  if (page.items.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
        <p className="text-base font-medium text-neutral-900">{t('queueEmptyTitle')}</p>
        <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('queueEmptyBody')}</p>
      </div>
    );
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((item) => (
          <TicketRow key={item.id} ticket={item} t={t} showOutcome={false} />
        ))}
      </ul>
      {page.nextCursor !== null && (
        <p className="mt-6 text-sm">
          <Link
            href={adminPath(`/support?cursor=${encodeURIComponent(page.nextCursor)}`)}
            className="underline underline-offset-4"
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </>
  );
}

/** The caller's own tickets, any status, newest first. */
export async function SupportAssigned({ cursor }: { readonly cursor: string | null }) {
  const t = await getTranslations('SupportConsole');
  const result = await readSupportAssigned({ cursor }, { cookieHeader: await currentCookieHeader() });

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const page = (result as { kind: 'ok'; data: SupportAssignedResponse }).data;

  if (page.items.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-neutral-200 p-6" role="status">
        <p className="text-base font-medium text-neutral-900">{t('assignedEmptyTitle')}</p>
        <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('assignedEmptyBody')}</p>
      </div>
    );
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((item) => (
          <TicketRow key={item.id} ticket={item} t={t} showOutcome />
        ))}
      </ul>
      {page.nextCursor !== null && (
        <p className="mt-6 text-sm">
          <Link
            href={adminPath(`/support?mine=${encodeURIComponent(page.nextCursor)}`)}
            className="underline underline-offset-4"
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One ticket                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function SupportTicketDetail({
  ticketId,
  cursor,
}: {
  readonly ticketId: string;
  readonly cursor: string | null;
}) {
  const t = await getTranslations('SupportConsole');
  const cookieHeader = await currentCookieHeader();
  const result = await readSupportConsoleTicket(ticketId, { cookieHeader });

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const ticket = (result as { kind: 'ok'; data: SupportConsoleTicket }).data;

  const isClosed = ticket.status === 'closed';
  const failureLabels = {
    notFound: t('failedNotFound'),
    conflict: t('failedConflict'),
    invalid: t('failedInvalid'),
    signedOut: t('failedSignedOut'),
    unavailable: t('failedGeneric'),
  };

  return (
    <>
      <section aria-labelledby="ticket-subject" className="mt-6 rounded-lg border border-neutral-200 p-4">
        {/*
          The subject, and it lives **here** rather than in the page's heading: inside the gate, so a colleague
          who may not read this ticket — or an outage — leaves a titled page carrying none of it. What a ticket
          is about is the first thing somebody working it needs, and nothing else on the screen says it.
        */}
        <h2 id="ticket-subject" className="text-lg font-medium text-neutral-900">
          {ticket.subject}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge label={t(`status.${ticket.status}`)} />
          <span className="text-sm text-neutral-600">{t(`category.${ticket.category}`)}</span>
          <span className="text-sm text-neutral-600">{t(`priority.${ticket.priority}`)}</span>
          {/* Whether somebody holds it, never who. */}
          <span className="text-sm font-medium text-neutral-900">
            {ticket.isMine ? t('heldByYou') : ticket.isAssigned ? t('heldByColleague') : t('unassigned')}
          </span>
        </div>

        <dl
          aria-label={t('ticketFacts')}
          className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700"
        >
          {ticket.reference !== null && <Cell label={t('reference')} value={ticket.reference} />}
          <Cell label={t('requester')} value={ticket.requesterName ?? t('requesterUnknown')} />
          <Cell label={t('openedAt')} value={minute(ticket.createdAt)} />
          {ticket.firstResponseAt !== null && (
            <Cell label={t('firstResponseAt')} value={minute(ticket.firstResponseAt)} />
          )}
          {ticket.lastMessageAt !== null && (
            <Cell label={t('lastActivity')} value={minute(ticket.lastMessageAt)} />
          )}
          {ticket.resolvedAt !== null && (
            <Cell label={t('resolvedAt')} value={minute(ticket.resolvedAt)} />
          )}
          {ticket.closedAt !== null && <Cell label={t('closedAt')} value={minute(ticket.closedAt)} />}
          <Cell label={t('messages')} value={String(ticket.messageCount)} />
          <Cell label={t('notes')} value={String(ticket.noteCount)} />
        </dl>

        {/*
          The assignment controls, and only the one that applies. A ticket a colleague holds is never rendered
          at all — the API refuses it — so the third case here is the caller's own.
        */}
        {!isClosed && !ticket.isAssigned && (
          <SupportAssignmentForm
            ticketId={ticket.id}
            step="claim"
            copy={{
              ...failureLabels,
              action: t('claimAction'),
              working: t('claimWorking'),
            }}
          />
        )}
        {!isClosed && ticket.isMine && (
          <SupportAssignmentForm
            ticketId={ticket.id}
            step="release"
            copy={{
              ...failureLabels,
              action: t('releaseAction'),
              working: t('releaseWorking'),
            }}
          />
        )}
        {isClosed && (
          <p role="status" className="mt-4 text-sm text-neutral-600">
            {t('closedHint')}
          </p>
        )}
      </section>

      <SupportConversation ticketId={ticket.id} cursor={cursor} />

      {/* Staff-only, and a separate read: absent entirely for a caller the API refuses. */}
      <SupportNotes ticketId={ticket.id} />

      {ticket.isMine && !isClosed && (
        <>
          <SupportReplyForm
            ticketId={ticket.id}
            copy={{
              ...failureLabels,
              label: t('replyLabel'),
              hint: t('replyHint'),
              send: t('replySend'),
              sending: t('replySending'),
              required: t('bodyRequired'),
              tooLong: t('bodyTooLong'),
            }}
          />
          <SupportNoteForm
            ticketId={ticket.id}
            copy={{
              ...failureLabels,
              label: t('noteLabel'),
              hint: t('noteHint'),
              send: t('noteSend'),
              sending: t('noteSending'),
              required: t('bodyRequired'),
              tooLong: t('bodyTooLong'),
            }}
          />
          <SupportDecisionForm
            ticketId={ticket.id}
            copy={{
              ...failureLabels,
              heading: t('decisionHeading'),
              hint: t('decisionHint'),
              // An already resolved ticket gets no resolve control and, deliberately, none of its words: a
              // string handed to a branch that will not render is still a string in the payload.
              resolve: ticket.status === 'resolved' ? null : t('resolveAction'),
              close: t('closeAction'),
              resolveQuestion: ticket.status === 'resolved' ? null : t('resolveQuestion'),
              closeQuestion: t('closeQuestion'),
              confirm: t('decisionConfirm'),
              cancel: t('decisionCancel'),
              working: t('decisionWorking'),
            }}
          />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The conversation and the notes                                                                    */
/* ------------------------------------------------------------------------------------------------ */

async function SupportConversation({
  ticketId,
  cursor,
}: {
  readonly ticketId: string;
  readonly cursor: string | null;
}) {
  const t = await getTranslations('SupportConsole');
  const result = await readSupportConsoleMessages(
    ticketId,
    { cursor },
    { cookieHeader: await currentCookieHeader() },
  );

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const page = (result as { kind: 'ok'; data: SupportConsoleMessagesResponse }).data;

  const attachmentCopy = {
    open: t('attachmentOpen'),
    opening: t('attachmentOpening'),
    notFound: t('failedNotFound'),
    conflict: t('failedConflict'),
    invalid: t('failedInvalid'),
    signedOut: t('failedSignedOut'),
    unavailable: t('failedGeneric'),
  };

  return (
    <section aria-labelledby="ticket-conversation" className="mt-8">
      <h2 id="ticket-conversation" className="text-lg font-medium text-neutral-900">
        {t('conversation')}
      </h2>
      {page.nextCursor !== null && (
        <p className="mt-2 text-sm">
          <Link
            href={adminPath(`/support/${ticketId}?cursor=${encodeURIComponent(page.nextCursor)}`)}
            className="underline underline-offset-4"
          >
            {t('olderMessages')}
          </Link>
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {page.items.map((message) => (
          <li key={message.id} className="rounded-lg border border-neutral-200 p-4">
            <p className="text-xs font-medium text-neutral-600">
              {/* The side, never the person. */}
              {message.authorRole === 'requester'
                ? t('fromRequester')
                : message.isOwnMessage
                  ? t('fromYou')
                  : t('fromSupport')}{' '}
              · {minute(message.createdAt)}
            </p>
            <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-neutral-900">
              {message.body}
            </p>
            {message.attachments.length > 0 && (
              <div className="mt-3 border-t border-neutral-200 pt-3">
                <p className="text-xs font-medium text-neutral-600">{t('files')}</p>
                <ul className="mt-2 space-y-2">
                  {message.attachments.map((attachment) => {
                    const size = kilobytes(attachment.byteSize);
                    return (
                      <li key={attachment.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-neutral-900">
                          {attachment.originalFilename ?? t('files')}
                          {size !== null && <span className="text-neutral-600"> · {size}</span>}
                        </span>
                        <SupportAttachmentButton
                          ticketId={ticketId}
                          attachmentId={attachment.id}
                          copy={attachmentCopy}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The internal notes.
 *
 * Rendered from its own read, so a caller the API refuses sees **no section at all** rather than an empty one.
 * A note says whether it is the caller's own and nothing else about who wrote it.
 */
async function SupportNotes({ ticketId }: { readonly ticketId: string }) {
  const t = await getTranslations('SupportConsole');
  const result = await readSupportInternalNotes(
    ticketId,
    {},
    { cookieHeader: await currentCookieHeader() },
  );
  if (result.kind !== 'ok') return null;
  const page = (result as { kind: 'ok'; data: SupportInternalNotesResponse }).data;

  return (
    <section aria-labelledby="ticket-notes" className="mt-8">
      <h2 id="ticket-notes" className="text-lg font-medium text-neutral-900">
        {t('notesHeading')}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-neutral-600">{t('notesIntro')}</p>
      {page.items.length === 0 ? (
        <p role="status" className="mt-4 text-sm text-neutral-600">
          {t('notesEmpty')}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {page.items.map((note) => (
            <li key={note.id} className="rounded-lg border border-dashed border-neutral-400 p-4">
              <p className="text-xs font-medium text-neutral-600">
                {note.isOwnNote ? t('noteByYou') : t('noteByColleague')} · {minute(note.createdAt)}
              </p>
              <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-neutral-900">
                {note.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
