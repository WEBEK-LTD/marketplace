import Link from 'next/link';
import type { SupportMessage, SupportTicketDetail, SupportTicketSummary } from '@repo/contracts';
import { SupportAttachmentLink, type AttachmentCopy } from './support-attachment-link';

/**
 * The support ticket list, ticket header and conversation (Phase 7-K).
 *
 * **Server components.** Everything a requester reads about their own ticket — the reference, the subject,
 * the category, the status, the counts, the times, the conversation and the names of the files on it — is
 * rendered here, on the server. Only the forms and the one attachment button are client components, and what
 * crosses to them is an identifier or two and a handful of words.
 *
 * **What is not here at all.** No assigned agent, no assignment time, no priority, no first-response time, no
 * internal note and no author identifier appear in this file, because none of them is in the contract these
 * components are typed against — so none of them can be in the RSC payload either, whatever a later change to
 * a page does.
 *
 * **A message names a side, not a person.** `authorRole` decides the words; there is nothing in this file that
 * could render who an agent is, because the server never says.
 *
 * **An attachment is a name and a size.** The file itself is reached through a short-lived link a person asks
 * for by pressing a button, so no storage path and no signed URL is ever rendered into the page.
 */

export interface SupportCopy {
  readonly listLabel: string;
  readonly reference: string;
  readonly category: string;
  readonly categories: Readonly<Record<string, string>>;
  readonly status: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly messages: (count: number) => string;
  readonly files: (count: number) => string;
  readonly opened: string;
  readonly lastActivity: string;
  readonly closedAt: string;
  readonly resolvedAt: string;
  readonly openTicket: string;
  readonly conversation: string;
  readonly you: string;
  readonly agent: string;
  readonly attachments: string;
  readonly olderMessages: string;
  readonly attachment: AttachmentCopy;
}

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

/** A size in whole kilobytes, or null when the row carried none. Never a byte count in a sentence. */
function kilobytes(value: string | null): string | null {
  if (value === null) return null;
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function StatusPill({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium text-neutral-700">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

function TicketCard({
  ticket,
  copy,
  href,
}: {
  readonly ticket: SupportTicketSummary;
  readonly copy: SupportCopy;
  readonly href: string;
}) {
  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-neutral-900">
            <Link href={href} className="underline underline-offset-4">
              {ticket.subject}
            </Link>
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            {copy.categories[ticket.category] ?? ticket.category}
            {ticket.reference !== null && (
              <>
                {' · '}
                <span className="font-mono text-xs">{ticket.reference}</span>
              </>
            )}
          </p>
        </div>
        <StatusPill label={copy.statuses[ticket.status] ?? ticket.status} />
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-neutral-600">{copy.opened}</dt>
          <dd className="text-neutral-900">{minute(ticket.createdAt)}</dd>
        </div>
        {ticket.lastMessageAt !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.lastActivity}</dt>
            <dd className="text-neutral-900">{minute(ticket.lastMessageAt)}</dd>
          </div>
        )}
        {ticket.closedAt !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.closedAt}</dt>
            <dd className="text-neutral-900">{minute(ticket.closedAt)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-3 text-sm text-neutral-600">
        {copy.messages(ticket.messageCount)}
        {ticket.attachmentCount > 0 && <> · {copy.files(ticket.attachmentCount)}</>}
      </p>
    </li>
  );
}

export function SupportTicketList({
  items,
  copy,
  base,
}: {
  readonly items: readonly SupportTicketSummary[];
  readonly copy: SupportCopy;
  readonly base: string;
}) {
  return (
    <section aria-labelledby="support-tickets" className="mt-8">
      <h2 id="support-tickets" className="sr-only">
        {copy.listLabel}
      </h2>
      <ul className="grid gap-4">
        {items.map((ticket) => (
          <TicketCard key={ticket.id} ticket={ticket} copy={copy} href={`${base}/${ticket.id}`} />
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One ticket                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export function SupportTicketHeader({
  ticket,
  copy,
}: {
  readonly ticket: SupportTicketDetail;
  readonly copy: SupportCopy;
}) {
  return (
    <section aria-labelledby="support-ticket-facts" className="mt-6 rounded-lg border border-neutral-200 p-4">
      <h2 id="support-ticket-facts" className="sr-only">
        {copy.status}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill label={copy.statuses[ticket.status] ?? ticket.status} />
        <span className="text-sm text-neutral-600">
          {copy.categories[ticket.category] ?? ticket.category}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {ticket.reference !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.reference}</dt>
            <dd className="font-mono text-xs text-neutral-900">{ticket.reference}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="text-neutral-600">{copy.opened}</dt>
          <dd className="text-neutral-900">{minute(ticket.createdAt)}</dd>
        </div>
        {ticket.lastMessageAt !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.lastActivity}</dt>
            <dd className="text-neutral-900">{minute(ticket.lastMessageAt)}</dd>
          </div>
        )}
        {ticket.resolvedAt !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.resolvedAt}</dt>
            <dd className="text-neutral-900">{minute(ticket.resolvedAt)}</dd>
          </div>
        )}
        {ticket.closedAt !== null && (
          <div className="flex gap-2">
            <dt className="text-neutral-600">{copy.closedAt}</dt>
            <dd className="text-neutral-900">{minute(ticket.closedAt)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The conversation                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

function MessageRow({
  ticketId,
  message,
  copy,
}: {
  readonly ticketId: string;
  readonly message: SupportMessage;
  readonly copy: SupportCopy;
}) {
  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <p className="text-xs font-medium text-neutral-600">
        {message.isOwnMessage ? copy.you : copy.agent} · {minute(message.createdAt)}
      </p>
      {/* `whitespace-pre-line` keeps the paragraphs somebody typed without rendering anything as markup. */}
      <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-neutral-900">{message.body}</p>

      {message.attachments.length > 0 && (
        <div className="mt-3 border-t border-neutral-200 pt-3">
          <p className="text-xs font-medium text-neutral-600">{copy.attachments}</p>
          <ul className="mt-2 grid gap-2">
            {message.attachments.map((attachment) => {
              const size = kilobytes(attachment.byteSize);
              return (
                <li key={attachment.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-neutral-900">
                    {attachment.originalFilename ?? copy.attachments}
                    {size !== null && <span className="text-neutral-600"> · {size}</span>}
                  </span>
                  <SupportAttachmentLink
                    ticketId={ticketId}
                    attachmentId={attachment.id}
                    copy={copy.attachment}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

export function SupportConversation({
  ticketId,
  messages,
  copy,
  olderHref,
}: {
  readonly ticketId: string;
  readonly messages: readonly SupportMessage[];
  readonly copy: SupportCopy;
  readonly olderHref: string | null;
}) {
  return (
    <section aria-labelledby="support-conversation" className="mt-8">
      <h2 id="support-conversation" className="text-lg font-medium text-neutral-900">
        {copy.conversation}
      </h2>
      {olderHref !== null && (
        <Link href={olderHref} className="mt-2 inline-block text-sm underline underline-offset-4">
          {copy.olderMessages}
        </Link>
      )}
      <ul className="mt-4 grid gap-4">
        {messages.map((message) => (
          <MessageRow key={message.id} ticketId={ticketId} message={message} copy={copy} />
        ))}
      </ul>
    </section>
  );
}
