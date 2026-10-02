import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { MarkAllNotificationsRead } from '../../../../components/notification-actions';
import {
  NotificationList,
  NotificationsEmpty,
  NotificationsError,
  NotificationsSkeleton,
  UnreadBadge,
  type NotificationCopy,
} from '../../../../components/notification-views';
import { RequireSession } from '../../../../components/require-session';
import { readNotifications, readNotificationsUnreadCount } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Notifications');
  // Explicit, because the root layout's default is noindex and a signed-in surface must stay that way.
  return { title: t('title'), robots: { index: false, follow: false } };
}

const VIEWS = ['inbox', 'archived'] as const;
type View = (typeof VIEWS)[number];

/**
 * The in-app notification surface (Phase 7-C).
 *
 * **Two independent reads, and the independence is the requirement.** The list and the unread badge are
 * fetched separately so a failing counter cannot take the list down with it, exactly as the 5-D inbox
 * does. A badge whose own request failed renders nothing at all — never a zero, which would be a number
 * this page invented and a person could act on.
 *
 * The whole body sits inside {@link RequireSession}, which is what keeps a signed-out visitor from
 * receiving any of it. That wrapper is a server component rather than a layout for a measured reason: a
 * layout that declines to render its children still streams the page's own subtree into the RSC payload,
 * so the gate has to be inside the page.
 *
 * **Two views, because the schema draws exactly one split.** The inbox is the unarchived notifications and
 * the archived view is the rest — the same division `notifications_unread` is indexed on and
 * `unread_notification_count` counts by. An unrecognised `view` falls back to the inbox rather than
 * erroring: it is a mistake in a link, and the right recovery is the list somebody meant to see.
 *
 * **What crosses into the client.** Only the per-row action buttons are client components, and their props
 * are one identifier and four words each. The category, the subject, the timestamp and the link are all
 * rendered here, on the server, so nothing else about a notification is in the RSC payload.
 *
 * Nothing here mutates. Opening this page marks nothing read; that is a button somebody presses.
 */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('Notifications'),
  ]);

  const requested = typeof query['view'] === 'string' ? query['view'] : null;
  const view: View = requested === 'archived' ? 'archived' : 'inbox';
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/notifications`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Heading level={1}>{t('title')}</Heading>
            <Suspense fallback={null}>
              <BadgeSection label={t('unreadBadge')} />
            </Suspense>
          </div>
          <p className="mt-2 text-neutral-600">{t('intro')}</p>

          <nav aria-label={t('title')} className="mt-6 flex flex-wrap gap-4">
            {VIEWS.map((candidate) => (
              <Link
                key={candidate}
                href={candidate === 'inbox' ? base : `${base}?view=archived`}
                aria-current={candidate === view ? 'page' : undefined}
                className={
                  candidate === view
                    ? 'text-sm font-medium text-neutral-900 underline underline-offset-4'
                    : 'text-sm text-neutral-600 underline decoration-neutral-300 underline-offset-4'
                }
              >
                {candidate === 'inbox' ? t('tabInbox') : t('tabArchived')}
              </Link>
            ))}
            {view === 'inbox' && (
              <MarkAllNotificationsRead label={t('markAllRead')} copy={actionCopy(t)} />
            )}
          </nav>

          <Suspense fallback={<NotificationsSkeleton label={t('title')} />}>
            <ListSection
              view={view}
              cursor={cursor}
              base={base}
              prefix={prefix}
              copy={copyFor(t)}
              listLabel={t('title')}
              emptyTitle={view === 'archived' ? t('emptyArchived') : t('empty')}
              emptyHint={view === 'archived' ? t('emptyArchivedHint') : t('emptyHint')}
              errorTitle={t('error')}
              retry={t('retry')}
              older={t('older')}
            />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

/**
 * The badge, read on its own.
 *
 * Anything other than a successful read renders nothing: an unavailable counter and a signed-out session
 * both leave the heading without a number, which is the honest outcome. A zero would be a claim.
 */
async function BadgeSection({ label }: { readonly label: string }) {
  const requestHeaders = await headers();
  const result = await readNotificationsUnreadCount({ cookieHeader: requestHeaders.get('cookie') });
  return <UnreadBadge count={result.kind === 'ok' ? result.data : null} label={label} />;
}

/** The list, read on its own, with each outcome rendered as itself. */
async function ListSection({
  view,
  cursor,
  base,
  prefix,
  copy,
  listLabel,
  emptyTitle,
  emptyHint,
  errorTitle,
  retry,
  older,
}: {
  readonly view: View;
  readonly cursor: string | null;
  readonly base: string;
  readonly prefix: string;
  readonly copy: NotificationCopy;
  readonly listLabel: string;
  readonly emptyTitle: string;
  readonly emptyHint: string;
  readonly errorTitle: string;
  readonly retry: string;
  readonly older: string;
}) {
  const requestHeaders = await headers();
  const result = await readNotifications(
    { view, cursor },
    { cookieHeader: requestHeaders.get('cookie') },
  );

  const viewHref = view === 'archived' ? `${base}?view=archived` : base;

  // A refused cursor and an unavailable service are both recoverable by starting again, and the link
  // that recovers from them is the same one: this view, with no cursor.
  if (result.kind !== 'ok') {
    return <NotificationsError title={errorTitle} retry={retry} href={viewHref} />;
  }
  if (result.data.items.length === 0) {
    return <NotificationsEmpty title={emptyTitle} hint={emptyHint} />;
  }

  const next = result.data.nextCursor;
  return (
    <>
      <NotificationList
        items={result.data.items}
        copy={copy}
        localePrefix={prefix}
        label={listLabel}
      />
      {next !== null && (
        <Link
          href={
            view === 'archived'
              ? `${base}?view=archived&cursor=${encodeURIComponent(next)}`
              : `${base}?cursor=${encodeURIComponent(next)}`
          }
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          {older}
        </Link>
      )}
    </>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Notifications'>>>;

/** The four words the client buttons need, and nothing else. */
function actionCopy(t: Translate) {
  return {
    markRead: t('markRead'),
    archive: t('archive'),
    working: t('working'),
    failed: t('actionFailed'),
  };
}

/**
 * The row copy, resolved on the server.
 *
 * The category and subject labels are built from the schema's own closed lists, so a value the database
 * can hold always has a name here — and a value it cannot hold has none to find.
 */
function copyFor(t: Translate): NotificationCopy {
  const categories: Record<string, string> = {};
  for (const key of [
    'orders',
    'payments',
    'payouts',
    'listings',
    'messages',
    'offers',
    'reviews',
    'promotions',
    'support',
    'security',
    'account',
    'system',
  ] as const) {
    categories[key] = t(`category.${key}`);
  }

  const subjects: Record<string, string> = {};
  for (const key of [
    'order',
    'checkout',
    'payment',
    'payout',
    'withdrawal',
    'listing',
    'conversation',
    'message',
    'offer',
    'service_request',
    'review',
    'promotion',
    'support_ticket',
    'dispute',
    'report',
    'account_recovery',
    'seller_verification',
  ] as const) {
    subjects[key] = t(`subject.${key}`);
  }

  return { categories, subjects, unread: t('unread'), open: t('open'), actions: actionCopy(t) };
}
