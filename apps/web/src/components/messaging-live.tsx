'use client';

import type { MessageAttachment } from '@repo/contracts';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  mergeConversations,
  mergeMessages,
  mergeUnreadCount,
  type PollCycle,
} from './message-polling';
import { fetchInboxPage, fetchLatestMessages, fetchUnreadCount } from './messaging-read';
import {
  AttachToMessage,
  AttachmentDownload,
  type AttachmentCopy,
} from './messaging-attachments';
import { ReportAction, type ReportCopy } from './messaging-report';
import { useMessagePolling } from './use-message-polling';
import {
  ConversationList,
  ConversationThread,
  UnreadBadge,
  type InboxLabels,
  type MessageLabels,
  type RenderableConversation,
  type RenderableMessage,
} from './messaging-views';

/**
 * The two messaging surfaces, kept current by polling (Phase 5-F).
 *
 * Both components are thin. They hold the rows or the messages, hand a merge function the server's latest
 * answer, and render the same presentational components the server rendered on the first pass. Every rule
 * worth testing — the cadence, the visibility pause, the no-overlap guard, the staleness check, the merge
 * itself — lives in `message-polling.ts` and `messaging-read.ts`.
 *
 * **Polling reads. It never writes.** Neither component can mark read, send, mute, leave or close: it
 * imports no function that does. Opening a thread still does not mark it read, and a poll certainly does
 * not — a surface that quietly cleared someone's unread badge because they left a tab open would be the
 * worst kind of surprise.
 *
 * **Nothing is invented.** There is no optimistic message, no client-generated id, no client timestamp,
 * and no fabricated count. Every value rendered came from a server response.
 *
 * **A failed poll changes nothing.** The last good content stays exactly as it is. No spinner on a poll,
 * no toast, no error screen replacing a working page: a transient failure should be invisible, because to
 * the reader nothing has happened.
 *
 * **Pagination is untouched.** "Load more" and "Load older messages" are still the server-rendered links
 * carrying the API's own opaque cursor, and polling never rewrites the position they point at.
 */

/** The row copy, as plain strings — a function cannot cross from a server component into this one. */
export interface InboxCopy {
  readonly empty: string;
  readonly emptyHint: string;
  readonly closed: string;
  readonly muted: string;
  readonly left: string;
  readonly noMessages: string;
  readonly unread: string;
  readonly more: string;
  /** The screen-reader heading of the list section, which this component owns. */
  readonly sectionHeading: string;
  readonly subjectListing: string;
  readonly subjectDirect: string;
  readonly subjectServiceRequest: string;
  readonly subjectOrder: string;
}

/** The inbox and the badge share one cadence, so they share one poller. */
export const INBOX_POLL_INTERVAL_MS = 15_000;

/** A thread is the surface someone watches, so it is the faster of the two. */
export const THREAD_POLL_INTERVAL_MS = 5_000;

const browserFetch = (input: string, init: RequestInit): Promise<Response> => fetch(input, init);

function inboxLabelsFrom(copy: InboxCopy): InboxLabels {
  return {
    empty: copy.empty,
    emptyHint: copy.emptyHint,
    closed: copy.closed,
    muted: copy.muted,
    left: copy.left,
    noMessages: copy.noMessages,
    unreadLabel: (count) => `${count} ${copy.unread}`,
    subjectLabel: (subjectType) => {
      if (subjectType === 'listing') return copy.subjectListing;
      if (subjectType === 'service_request') return copy.subjectServiceRequest;
      if (subjectType === 'order') return copy.subjectOrder;
      return copy.subjectDirect;
    },
  };
}

export interface LiveInboxProps {
  /** The rows the server rendered, or `null` when that read failed and `children` is the error view. */
  readonly initialRows: readonly RenderableConversation[] | null;
  readonly initialUnread: number | null;
  /** The API's own cursor for the page being shown, so a poll refreshes this page and not the first. */
  readonly cursor: string | null;
  readonly initialNextCursor: string | null;
  /** `''` or `/ar`. Every link on this surface is built from it. */
  readonly prefix: string;
  readonly copy: InboxCopy;
  /** The server-rendered error view, present only when the initial read actually failed. */
  readonly children?: ReactNode;
}

export function LiveInbox({
  initialRows,
  initialUnread,
  cursor,
  initialNextCursor,
  prefix,
  copy,
  children,
}: LiveInboxProps) {
  const [rows, setRows] = useState<readonly RenderableConversation[] | null>(initialRows);
  const [unread, setUnread] = useState<number | null>(initialUnread);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);

  const poll = useCallback(
    async (cycle: PollCycle): Promise<void> => {
      // Both reads in one cycle, and each is its own outcome: a failing counter must not cost the list
      // its rows, and a failing list must not blank a count that came back fine.
      const [page, count] = await Promise.all([
        fetchInboxPage(cursor, browserFetch),
        fetchUnreadCount(browserFetch),
      ]);
      if (!cycle.isCurrent()) return;

      if (page.kind === 'ok') {
        setRows((current) => mergeConversations(current ?? [], page.data.rows));
        setNextCursor(page.data.nextCursor);
      }
      setUnread((current) => mergeUnreadCount(current, count.kind === 'ok' ? count.data : null));
    },
    [cursor],
  );

  useMessagePolling(INBOX_POLL_INTERVAL_MS, poll);

  const labels = inboxLabelsFrom(copy);
  const moreHref =
    nextCursor === null ? null : `${prefix}/dashboard/messages?cursor=${encodeURIComponent(nextCursor)}`;

  return (
    <>
      <UnreadBadge count={unread} label={labels.unreadLabel} />

      <section aria-labelledby="messages-inbox">
        <h2 id="messages-inbox" className="sr-only">
          {copy.sectionHeading}
        </h2>
        {rows === null ? (
          children
        ) : (
          <>
            <ConversationList
              conversations={rows}
              hrefFor={(conversationId) => `${prefix}/dashboard/messages/${conversationId}`}
              labels={labels}
            />
            {moreHref === null ? null : (
              <p className="mt-6">
                <Link
                  href={moreHref}
                  className="text-sm underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900"
                >
                  {copy.more}
                </Link>
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}

export interface LiveThreadProps {
  readonly conversationId: string;
  readonly initialMessages: readonly RenderableMessage[];
  readonly referenceTitle: string | null;
  readonly isClosed: boolean;
  /** The server-rendered "load older" link, carrying the API's opaque cursor. Polling never changes it. */
  readonly olderHref: string | null;
  readonly labels: MessageLabels;
  /**
   * The report copy, as plain strings — a function cannot cross from a server component into this one, so
   * the per-message report control is built here rather than handed over. Omit it and the thread renders
   * exactly as it did before 5-H.
   */
  readonly reportCopy?: ReportCopy;
  /**
   * The attachment copy (0104), as plain strings for the same reason the report copy is.
   *
   * Omit it and the thread renders exactly as it did before 0104: files still appear, because they are part of
   * a message, but with no download button and no attach button.
   */
  readonly attachmentCopy?: AttachmentCopy;
}

export function LiveThread({
  conversationId,
  initialMessages,
  referenceTitle,
  isClosed,
  olderHref,
  labels,
  reportCopy,
  attachmentCopy,
}: LiveThreadProps) {
  const [messages, setMessages] = useState<readonly RenderableMessage[]>(initialMessages);

  const poll = useCallback(
    async (cycle: PollCycle): Promise<void> => {
      const latest = await fetchLatestMessages(conversationId, browserFetch);
      if (!cycle.isCurrent() || latest.kind !== 'ok') return;
      // Merged, never substituted: the latest page is one page, and the reader may have loaded older ones.
      setMessages((current) => mergeMessages(current, latest.data));
    },
    [conversationId],
  );

  useMessagePolling(THREAD_POLL_INTERVAL_MS, poll);

  return (
    <ConversationThread
      messages={messages}
      referenceTitle={referenceTitle}
      isClosed={isClosed}
      olderHref={olderHref}
      labels={labels}
      {...(reportCopy === undefined && attachmentCopy === undefined
        ? {}
        : {
            actionFor: (message: RenderableMessage) => (
              <span className="mt-2 flex flex-wrap items-center gap-3">
                {reportCopy === undefined ? null : (
                  <ReportAction subject={{ kind: 'message', messageId: message.id }} copy={reportCopy} />
                )}
                {/*
                  0104. Offered on the caller's own messages only, which is the database's rule restated where
                  a person can see it rather than discovered by pressing a button that always refuses. A closed
                  or left thread shows none, because neither takes anything new.
                */}
                {attachmentCopy !== undefined && message.isOwnMessage && !isClosed ? (
                  <AttachToMessage
                    conversationId={conversationId}
                    messageId={message.id}
                    copy={attachmentCopy}
                  />
                ) : null}
              </span>
            ),
          })}
      {...(attachmentCopy === undefined
        ? {}
        : {
            attachmentActionFor: (attachment: MessageAttachment) => (
              <AttachmentDownload
                conversationId={conversationId}
                attachmentId={attachment.id}
                copy={attachmentCopy}
              />
            ),
          })}
    />
  );
}
