import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AccountError } from '../../../../../components/account-views';
import { RequireSession } from '../../../../../components/require-session';
import { closeTicketCopy, replyCopy, supportCopy } from '../../../../../components/support-copy';
import { CloseSupportTicketForm, SupportReplyForm } from '../../../../../components/support-forms';
import {
  SupportConversation,
  SupportTicketHeader,
} from '../../../../../components/support-views';
import { readSupportMessages, readSupportTicket } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Support');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * One support ticket the reader raised (Phase 7-K).
 *
 * **Both reads sit inside the gate, and both are the caller's own.** The ticket and its conversation are two
 * operations because they page separately; each is scoped to the account inside the database, and a ticket that
 * is not the reader's arrives as the same `notFound` as one that does not exist — so this page renders one
 * sentence for both and has no branch that could tell them apart.
 *
 * **What the page does not have.** No assignment control, no internal note, no status control and no priority:
 * the only writes here are a reply and ending the ticket, and the second one takes no status because the server
 * takes none. There is no reopen, because nothing in the repository reopens a ticket.
 *
 * **Order.** The API hands back a page already in reading order, chosen backwards from the cursor, so it is
 * rendered exactly as received. Re-sorting here would be a second opinion about a settled order.
 */
export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale; readonly ticketId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale, ticketId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('Support'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/support`;
  const here = `${base}/${ticketId}`;
  const cookieHeader = (await headers()).get('cookie');

  const [ticket, conversation] = await Promise.all([
    readSupportTicket(ticketId, { cookieHeader }),
    readSupportMessages(ticketId, { cursor }, { cookieHeader }),
  ]);

  const copy = supportCopy(t);

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          {ticket.kind === 'ok' ? (
            <>
              <Heading level={1}>{ticket.data.ticket.subject}</Heading>
              <p className="mt-2">
                <Link
                  href={base}
                  className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong"
                >
                  {t('title')}
                </Link>
              </p>

              <SupportTicketHeader ticket={ticket.data.ticket} copy={copy} />

              {conversation.kind === 'ok' ? (
                <SupportConversation
                  ticketId={ticket.data.ticket.id}
                  messages={conversation.data.items}
                  copy={copy}
                  olderHref={
                    conversation.data.nextCursor === null
                      ? null
                      : `${here}?cursor=${encodeURIComponent(conversation.data.nextCursor)}`
                  }
                />
              ) : (
                <AccountError title={t('error')} retry={t('retry')} href={here} />
              )}

              <SupportReplyForm
                ticketId={ticket.data.ticket.id}
                isClosed={ticket.data.ticket.status === 'closed'}
                copy={replyCopy(t)}
              />

              {ticket.data.ticket.status !== 'closed' && (
                <CloseSupportTicketForm ticketId={ticket.data.ticket.id} copy={closeTicketCopy(t)} />
              )}
            </>
          ) : ticket.kind === 'notFound' || ticket.kind === 'invalid' ? (
            <>
              <Heading level={1}>{t('title')}</Heading>
              {/* One wording for a ticket that is not theirs and one that does not exist. */}
              <p role="status" className="mt-8 text-ink-strong">
                {t('unavailableTicket')}
              </p>
              <p className="mt-4">
                <Link href={base} className="text-sm underline underline-offset-4">
                  {t('title')}
                </Link>
              </p>
            </>
          ) : (
            <>
              <Heading level={1}>{t('title')}</Heading>
              <AccountError title={t('error')} retry={t('retry')} href={here} />
            </>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
