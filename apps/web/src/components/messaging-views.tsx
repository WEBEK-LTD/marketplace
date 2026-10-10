import type { InboxItem, MessageAttachment, MessageItem } from '@repo/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The read-only messaging views (Phase 5-D).
 *
 * Everything here renders from the 5-C contract and nothing else. There is no fetch, no state and no
 * mutation in this file: no composer, no mute control, no leave button, no report action. Those belong to
 * later increments, and a disabled control that does nothing is a worse promise than an absent one.
 *
 * Two things shape the markup.
 *
 * **Direction is never assumed.** Every offset is a logical property — `ms-`, `me-`, `text-start`,
 * `border-s` — so the same components read correctly under `/ar` without a mirrored stylesheet.
 *
 * **A listing reference cannot leak.** The thread renders a reference message from the conversation's
 * own snapshot and the message's reference fields. It never constructs a public listing URL, because 5-C
 * gives it nothing to construct one from: the resolved reference is a later increment's data, and until
 * then an unavailable listing is exactly the words "No longer available".
 */

/**
 * What a rendered conversation row needs, which is deliberately less than the contract carries.
 *
 * `InboxItem` satisfies this structurally, so a server page passes one straight in. The point of the
 * narrower type is what it leaves out: `lastMessageSenderUserId`, `lastMessageId` and the rest of the
 * identifiers. Phase 5-F renders these rows from a client component, and a client component's props
 * travel to the browser inside the RSC payload — so a row type that *could* carry a user id would put
 * one in the document even though nothing on the page prints it.
 */
export interface RenderableConversation {
  readonly conversationId: string;
  readonly subjectType: InboxItem['subjectType'];
  readonly listingTitleSnapshot: string | null;
  readonly membershipState: InboxItem['membershipState'];
  readonly isMuted: boolean;
  readonly isClosed: boolean;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly lastMessageBody: string | null;
}

/**
 * The words a conversation row shows.
 *
 * The two callables are why this is built where it is rendered rather than passed across a boundary: a
 * function cannot cross from a server component into a client one, so 5-F's client inbox receives plain
 * strings and assembles this itself. The error and pagination copy is not here — it belongs to the page,
 * which owns those two elements, and keeping it out is what keeps "Unable to load messages" out of a
 * payload for a page that loaded perfectly well.
 */
export interface InboxLabels {
  readonly empty: string;
  readonly emptyHint: string;
  readonly closed: string;
  readonly muted: string;
  readonly unreadLabel: (count: number) => string;
  readonly subjectLabel: (subjectType: InboxItem['subjectType']) => string;
  readonly noMessages: string;
  readonly left: string;
}

/**
 * Narrows one contract row to what a row renders.
 *
 * Explicit rather than a cast, and that is the whole point. `InboxItem` satisfies
 * {@link RenderableConversation} structurally, so TypeScript would happily pass a full one through — and
 * the extra fields would still be in the object that Next.js serializes into the RSC payload for the
 * client list. Copying the nine fields by hand is what actually leaves `lastMessageSenderUserId`,
 * `lastMessageId` and the rest out of the document.
 */
export function renderableConversation(item: InboxItem): RenderableConversation {
  return {
    conversationId: item.conversationId,
    subjectType: item.subjectType,
    listingTitleSnapshot: item.listingTitleSnapshot,
    membershipState: item.membershipState,
    isMuted: item.isMuted,
    isClosed: item.isClosed,
    unreadCount: item.unreadCount,
    lastMessageAt: item.lastMessageAt,
    lastMessageBody: item.lastMessageBody,
  };
}

/** A small neutral chip, used for every state a row can carry. */
function Chip({ children }: { readonly children: string }) {
  return (
    <span className="rounded border border-edge px-1.5 py-0.5 text-xs text-ink-body">{children}</span>
  );
}

/**
 * One conversation in the list.
 *
 * The whole row is reachable by keyboard through the heading link, which carries the conversation's
 * accessible name; the chips and the summary are description, not navigation, so they add no tab stops.
 */
export function ConversationRow({
  conversation,
  href,
  labels,
}: {
  readonly conversation: RenderableConversation;
  readonly href: string;
  readonly labels: InboxLabels;
}) {
  const name =
    conversation.listingTitleSnapshot ?? labels.subjectLabel(conversation.subjectType);

  return (
    <li className="rounded-lg border border-hairline p-5">
      <h2 className="text-base font-medium text-ink-strong">
        <Link
          href={href}
          className="underline decoration-edge underline-offset-4 hover:decoration-ink-strong"
        >
          {name}
        </Link>
      </h2>

      <p className="mt-1 text-sm text-ink-muted">{labels.subjectLabel(conversation.subjectType)}</p>

      {conversation.lastMessageAt === null ? (
        <p className="mt-2 text-sm text-ink-muted">{labels.noMessages}</p>
      ) : (
        <>
          {conversation.lastMessageBody === null ? null : (
            <p className="mt-2 line-clamp-2 text-sm text-ink-strong">{conversation.lastMessageBody}</p>
          )}
          <p className="mt-1 text-xs text-ink-muted">
            <time dateTime={conversation.lastMessageAt}>{conversation.lastMessageAt}</time>
          </p>
        </>
      )}

      <p className="mt-3 flex flex-wrap items-center gap-2">
        {conversation.unreadCount > 0 ? <Chip>{labels.unreadLabel(conversation.unreadCount)}</Chip> : null}
        {conversation.isClosed ? <Chip>{labels.closed}</Chip> : null}
        {conversation.isMuted ? <Chip>{labels.muted}</Chip> : null}
        {conversation.membershipState === 'left' ? <Chip>{labels.left}</Chip> : null}
      </p>
    </li>
  );
}

/** The conversation list. One column: a row is a summary, not a card in a grid. */
export function ConversationList({
  conversations,
  hrefFor,
  labels,
}: {
  readonly conversations: readonly RenderableConversation[];
  readonly hrefFor: (conversationId: string) => string;
  readonly labels: InboxLabels;
}) {
  if (conversations.length === 0) {
    return (
      <div className="mt-8">
        <p className="text-ink-strong">{labels.empty}</p>
        <p className="mt-2 text-sm text-ink-muted">{labels.emptyHint}</p>
      </div>
    );
  }

  return (
    <ul className="mt-8 grid grid-cols-1 gap-4">
      {conversations.map((conversation) => (
        <ConversationRow
          key={conversation.conversationId}
          conversation={conversation}
          href={hrefFor(conversation.conversationId)}
          labels={labels}
        />
      ))}
    </ul>
  );
}

/** The loading state: a placeholder shaped like the list, so the page does not jump. */
export function ConversationListSkeleton({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="mt-8">
      <p className="text-sm text-ink-muted">{label}</p>
      <div aria-hidden="true" className="mt-3 grid grid-cols-1 gap-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-28 rounded-lg border border-hairline bg-surface-sunken" />
        ))}
      </div>
    </div>
  );
}

/**
 * A byte count as a short human string.
 *
 * The value is a decimal string because it is a `bigint` at the contract boundary, and it is parsed here with
 * `Number` rather than `BigInt` because a file size that does not fit in a double would be larger than any
 * bucket in this platform permits — and a size that fails to parse renders as nothing rather than as `NaN`.
 */
function formatBytes(value: string, labels: Pick<MessageLabels, 'kilobytes' | 'megabytes'>): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${labels.megabytes}`;
  return `${Math.max(1, Math.round(bytes / 1024))} ${labels.kilobytes}`;
}

/**
 * What a rendered message needs. `MessageItem` satisfies it structurally.
 *
 * No `senderUserId`, no `conversationId`, no `referenceId`: attribution is "You" or "Other participant"
 * and the reference card renders a title, so none of those is read here — and 5-F's client thread must
 * not ship them to a browser it does not print them on.
 *
 * `attachments` (0104) is here because the thread is a client component and the catch-up poll replaces these
 * rows wholesale, so an attachment that lived only in server markup would vanish on the first poll. What it
 * carries is an id, a type and a size: **no object path and no filename**, because the download is reached by
 * id and 0014 stores no name. There is nothing in it a browser should not have.
 */
export interface RenderableMessage {
  readonly id: string;
  readonly seq: string;
  readonly isOwnMessage: boolean;
  readonly messageType: MessageItem['messageType'];
  readonly body: string | null;
  readonly createdAt: string;
  readonly attachments: readonly MessageAttachment[];
}

export interface MessageLabels {
  /** 0104. The accessible name of a message's attachment list, and how each file is described. */
  readonly attachments: string;
  /** One word per permitted content type. A type with no label renders as itself rather than as nothing. */
  readonly attachmentTypes: Readonly<Record<string, string>>;
  readonly kilobytes: string;
  readonly megabytes: string;
  readonly noMessages: string;
  readonly closed: string;
  readonly closedHint: string;
  readonly noLongerAvailable: string;
  readonly system: string;
  readonly you: string;
  readonly otherParty: string;
  readonly loadOlder: string;
}

/** Narrows one message to what a message renders. Explicit, for the reason above: no sender leaves here. */
export function renderableMessage(item: MessageItem): RenderableMessage {
  return {
    id: item.id,
    seq: item.seq,
    isOwnMessage: item.isOwnMessage,
    messageType: item.messageType,
    body: item.body,
    createdAt: item.createdAt,
    attachments: item.attachments,
  };
}

/**
 * The reference card inside a thread.
 *
 * 5-D has no resolved listing reference to show — that resolver is read by a later increment — so this
 * renders the conversation's own stored snapshot when there is one, and otherwise says plainly that the
 * listing is no longer available. Deliberately not a link: a public URL cannot be built from a reference
 * whose availability is unknown, and inventing one would be the exact N8 leak this design avoids.
 */
export function MessageReferenceCard({
  title,
  labels,
}: {
  readonly title: string | null;
  readonly labels: MessageLabels;
}) {
  return (
    <div className="mt-2 rounded-md border border-hairline bg-surface-sunken p-3">
      <p className="text-sm text-ink-strong">{title ?? labels.noLongerAvailable}</p>
      {title === null ? null : (
        <p className="mt-1 text-xs text-ink-muted">{labels.noLongerAvailable}</p>
      )}
    </div>
  );
}

/** One message. A system message is centred and unattributed; everything else names its side. */
export function MessageRow({
  message,
  referenceTitle,
  labels,
  action,
  attachmentAction,
}: {
  readonly message: RenderableMessage;
  readonly referenceTitle: string | null;
  readonly labels: MessageLabels;
  /** A per-message control, when the surface has one. 5-H's report action is the only caller. */
  readonly action?: ReactNode;
  /**
   * A per-attachment control, when the surface has one. 0104's download link is the only caller.
   *
   * A function rather than a node so each file gets its own, and optional so a surface that only lists
   * attachments — a future digest, say — does not have to supply one.
   */
  readonly attachmentAction?: (attachment: MessageAttachment) => ReactNode;
}) {
  if (message.messageType === 'system') {
    return (
      <li className="py-3 text-center text-xs text-ink-muted">
        <span className="sr-only">{labels.system}: </span>
        {message.body}
        <p className="mt-1">
          <time dateTime={message.createdAt}>{message.createdAt}</time>
        </p>
      </li>
    );
  }

  // Attribution is "You" or "the other participant" and never an identifier. The projection carries a
  // sender uuid, which the caller is entitled to receive and has no business reading on a page: it
  // names nobody to a human and would be an internal identifier printed into the document.
  return (
    <li className="border-s-2 border-hairline ps-4 py-3">
      <p className="text-xs text-ink-muted">
        {message.isOwnMessage ? labels.you : labels.otherParty}
        {' · '}
        <time dateTime={message.createdAt}>{message.createdAt}</time>
      </p>
      {message.body === null ? null : (
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-strong">{message.body}</p>
      )}
      {message.messageType === 'reference' ? (
        <MessageReferenceCard title={referenceTitle} labels={labels} />
      ) : null}
      {message.attachments.length === 0 ? null : (
        <ul className="mt-2 space-y-1" aria-label={labels.attachments}>
          {message.attachments.map((attachment) => (
            <li key={attachment.id} className="text-xs text-ink-body">
              <span>{labels.attachmentTypes[attachment.contentType] ?? attachment.contentType}</span>
              <span className="ms-2 text-ink-muted">{formatBytes(attachment.byteSize, labels)}</span>
              {attachmentAction === undefined ? null : (
                <span className="ms-2">{attachmentAction(attachment)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {action}
    </li>
  );
}

/**
 * The thread.
 *
 * `items` arrives oldest-first from the API and is rendered in exactly that order: the server chose the
 * page backwards from the cursor and handed it back in reading order, so re-sorting here would be a
 * second opinion about an order that is already settled.
 *
 * "Load older" is a plain link carrying the opaque cursor the API issued. It is a link rather than a
 * button because it is navigation, which keeps it keyboard-accessible and working without JavaScript —
 * and because 5-D has no client state to accumulate into.
 */
export function ConversationThread({
  messages,
  referenceTitle,
  isClosed,
  olderHref,
  labels,
  actionFor,
  attachmentActionFor,
}: {
  readonly messages: readonly RenderableMessage[];
  readonly referenceTitle: string | null;
  readonly isClosed: boolean;
  readonly olderHref: string | null;
  readonly labels: MessageLabels;
  /**
   * The per-message control, if the surface offers one. A function rather than a node so each row gets
   * its own: 5-H's report action is per message, and one shared node would report one message everywhere.
   */
  readonly actionFor?: (message: RenderableMessage) => ReactNode;
  /** The per-attachment control, if the surface offers one. 0104's download link is the only caller. */
  readonly attachmentActionFor?: (attachment: MessageAttachment) => ReactNode;
}) {
  return (
    <div className="mt-8">
      {olderHref === null ? null : (
        <p className="mb-4">
          <Link
            href={olderHref}
            className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong"
          >
            {labels.loadOlder}
          </Link>
        </p>
      )}

      {messages.length === 0 ? (
        <p className="text-ink-muted">{labels.noMessages}</p>
      ) : (
        <ul>
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              referenceTitle={referenceTitle}
              labels={labels}
              action={actionFor === undefined ? undefined : actionFor(message)}
              {...(attachmentActionFor === undefined ? {} : { attachmentAction: attachmentActionFor })}
            />
          ))}
        </ul>
      )}

      {isClosed ? (
        <div role="status" className="mt-8 rounded-md border border-hairline bg-surface-sunken p-4">
          <p className="text-sm font-medium text-ink-strong">{labels.closed}</p>
          <p className="mt-1 text-sm text-ink-muted">{labels.closedHint}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The global unread badge.
 *
 * Renders nothing at all when the count is unknown. That is the whole requirement: a badge whose own
 * request failed must not show a number, and must not take the page down with it.
 */
export function UnreadBadge({
  count,
  label,
}: {
  readonly count: number | null;
  readonly label: (count: number) => string;
}) {
  if (count === null || count === 0) return null;
  return (
    <p className="mt-2">
      <span className="rounded-full border border-edge px-2 py-0.5 text-xs text-ink-body">
        {label(count)}
      </span>
    </p>
  );
}

/** The error state for a section that could not load. A link, so retrying needs no JavaScript. */
export function MessagingError({
  title,
  retryLabel,
  retryHref,
}: {
  readonly title: string;
  readonly retryLabel: string;
  readonly retryHref: string;
}) {
  return (
    <div role="alert" className="mt-8">
      <p className="text-ink-strong">{title}</p>
      <p className="mt-2">
        <Link
          href={retryHref}
          className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong"
        >
          {retryLabel}
        </Link>
      </p>
    </div>
  );
}
