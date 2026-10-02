import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { LiveInbox, type InboxCopy } from '../../../../components/messaging-live';
import {
  ConversationListSkeleton,
  MessagingError,
  renderableConversation,
} from '../../../../components/messaging-views';
import { RequireSession } from '../../../../components/require-session';
import { readInbox, readUnreadCount } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Messages');
  // Explicit, because the root layout's default is noindex and a signed-in surface must stay that way.
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The inbox (Phase 5-D read, Phase 5-F catch-up).
 *
 * Two independent reads, and the independence is the requirement: the conversation list and the unread
 * badge are fetched separately so a failing counter cannot take the list down with it. A badge whose
 * own request failed renders nothing at all — never a zero, which would be a number this page invented.
 * The same split holds once the page is live: one poller, two requests, each its own outcome.
 *
 * The whole body sits inside {@link RequireSession}, which is what keeps a signed-out visitor from
 * receiving any of it. That wrapper is a server component rather than a layout for a measured reason:
 * a layout that declines to render its children still streams the page's own subtree into the RSC
 * payload, so the gate has to be inside the page.
 *
 * **What crosses into the client, and what does not.** 5-F renders the rows from a client component, and a
 * client component's props travel to the browser inside the RSC payload. So the rows are narrowed to what
 * a row displays — no `lastMessageSenderUserId`, no message ids — and the error copy stays here, on the
 * server, built only when a read actually failed. A page that loaded perfectly must not ship the words
 * "Unable to load messages" to anybody.
 *
 * Nothing here mutates. Opening the inbox does not mark anything read, and neither does a poll.
 */
export default async function MessagesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('Messages'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 text-neutral-600">{t('yourMessages')}</p>

          <Suspense fallback={<ConversationListSkeleton label={t('title')} />}>
            <InboxSection
              cursor={cursor}
              prefix={prefix}
              copy={inboxCopy(t)}
              errorTitle={t('error')}
              retryLabel={t('retry')}
              retryHref={`${prefix}/dashboard/messages`}
            />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

/**
 * The row copy, as plain strings.
 *
 * Plain strings because the live list is a client component and a function cannot cross that boundary:
 * the two callable labels are assembled on the other side from exactly these words, so the rendered
 * output is the same either way.
 */
function inboxCopy(t: Awaited<ReturnType<typeof getTranslations<'Messages'>>>): InboxCopy {
  return {
    empty: t('empty'),
    emptyHint: t('emptyHint'),
    closed: t('closed'),
    muted: t('mutedState'),
    left: t('leftState'),
    noMessages: t('noMessages'),
    unread: t('unread'),
    more: t('loadMore'),
    sectionHeading: t('yourMessages'),
    subjectListing: t('subjectListing'),
    subjectDirect: t('subjectDirect'),
    subjectServiceRequest: t('subjectServiceRequest'),
    subjectOrder: t('subjectOrder'),
  };
}

/**
 * Both reads, then the live list.
 *
 * The two requests go out together and are read apart: a failed count becomes `null`, which the badge
 * renders as nothing at all, and a failed list becomes the error view — which is built here, on the
 * server, and handed over as the children the live component shows while it has no rows.
 */
async function InboxSection({
  cursor,
  prefix,
  copy,
  errorTitle,
  retryLabel,
  retryHref,
}: {
  readonly cursor: string | null;
  readonly prefix: string;
  readonly copy: InboxCopy;
  readonly errorTitle: string;
  readonly retryLabel: string;
  readonly retryHref: string;
}) {
  const cookieHeader = (await headers()).get('cookie');
  // The cursor is handed to the BFF exactly as the API issued it. This page never parses one.
  const [inbox, unread] = await Promise.all([
    readInbox({ cursor }, { cookieHeader }),
    readUnreadCount({ cookieHeader }),
  ]);

  return (
    <LiveInbox
      initialRows={inbox.kind === 'ok' ? inbox.data.items.map(renderableConversation) : null}
      initialUnread={unread.kind === 'ok' ? unread.data : null}
      initialNextCursor={inbox.kind === 'ok' ? inbox.data.nextCursor : null}
      cursor={cursor}
      prefix={prefix}
      copy={copy}
    >
      {inbox.kind === 'ok' ? null : (
        <MessagingError title={errorTitle} retryLabel={retryLabel} retryHref={retryHref} />
      )}
    </LiveInbox>
  );
}
