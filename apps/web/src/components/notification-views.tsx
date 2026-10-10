import type { NotificationItem } from '@repo/contracts';
import Link from 'next/link';
import { NotificationActions, type NotificationActionCopy } from './notification-actions';

/**
 * The notification surface's server-rendered pieces (Phase 7-C).
 *
 * **These render metadata, not prose, and that is a constraint rather than a shortcut.** A notification
 * row carries the category, the event type, the subject and a relative action path — the fields migration
 * 0029 defines. There is no title and no body anywhere in this project: `public.email_templates` holds no
 * rows, there is no in-app template renderer, and writing a sentence per event type here would be
 * inventing the very vocabulary this increment must not invent. So a row shows the **category** in the
 * reader's own language — the twelve categories are a closed list in the schema, so naming them is
 * translating something that exists — the event type as the token it is, and a link where the row has one.
 *
 * **The narrowed row is what crosses into the client.** Only the identifier and the labels reach
 * {@link NotificationActions}; nothing else about a notification is in the RSC payload for the buttons.
 */

/** Everything a row displays, in the reader's language. */
export interface NotificationCopy {
  readonly categories: Readonly<Record<string, string>>;
  readonly subjects: Readonly<Record<string, string>>;
  readonly unread: string;
  readonly open: string;
  readonly actions: NotificationActionCopy;
}

/** The empty, error and skeleton states, which every list surface in this app renders in the same shape. */
export function NotificationsEmpty({
  title,
  hint,
}: {
  readonly title: string;
  readonly hint: string;
}) {
  return (
    <div role="status" className="mt-8 rounded-md border border-hairline px-4 py-10 text-center">
      <p className="text-ink-strong">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">{hint}</p>
    </div>
  );
}

/**
 * The failure state.
 *
 * It says the list could not be loaded and offers a retry, and it never says "you have no notifications"
 * — a service that could not answer is not an empty inbox, and conflating them would be a statement a
 * person could act on wrongly.
 */
export function NotificationsError({
  title,
  retry,
  href,
}: {
  readonly title: string;
  readonly retry: string;
  readonly href: string;
}) {
  return (
    <div role="alert" className="mt-8 rounded-md border border-edge px-4 py-6">
      <p className="text-ink-strong">{title}</p>
      <Link href={href} className="mt-3 inline-block text-sm underline underline-offset-4">
        {retry}
      </Link>
    </div>
  );
}

/** The loading state, shaped like the list it replaces so the page does not jump when it arrives. */
export function NotificationsSkeleton({ label }: { readonly label: string }) {
  return (
    <ul aria-busy="true" aria-label={label} className="mt-8 space-y-3">
      {[0, 1, 2].map((row) => (
        <li key={row} className="rounded-md border border-hairline px-4 py-5">
          <div className="h-3 w-24 rounded bg-surface-muted" />
          <div className="mt-3 h-4 w-3/4 rounded bg-surface-muted" />
        </li>
      ))}
    </ul>
  );
}

/** The badge. Renders nothing at all for zero, and nothing when the count could not be read. */
export function UnreadBadge({ count, label }: { readonly count: number | null; readonly label: string }) {
  if (count === null || count <= 0) return null;
  return (
    <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-surface-ink px-2 py-0.5 text-xs font-medium text-on-ink">
      <span className="sr-only">{label}</span>
      {count}
    </span>
  );
}

/**
 * One notification.
 *
 * Unread rows are marked in two ways that do not depend on each other: a visible label and a heavier
 * border. Colour alone is never the signal, because a person who cannot distinguish it would otherwise
 * have no way to tell an unread notification from a read one.
 *
 * The action link is rendered only when the row has a path, and that path came through a database
 * constraint and a contract that both require it to be relative — so this component never has to decide
 * whether a destination is safe.
 */
export function NotificationRow({
  item,
  copy,
  localePrefix,
}: {
  readonly item: NotificationItem;
  readonly copy: NotificationCopy;
  readonly localePrefix: string;
}) {
  const isUnread = item.readAt === null;
  const category = copy.categories[item.category] ?? item.category;
  const subject = item.subjectType === null ? null : (copy.subjects[item.subjectType] ?? item.subjectType);

  return (
    <li
      className={`rounded-md border px-4 py-4 ${
        isUnread ? 'border-edge-strong bg-surface-raised' : 'border-hairline'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink-strong">{category}</span>
        {subject !== null && <span className="text-sm text-ink-muted">{subject}</span>}
        {isUnread && (
          <span className="rounded-full border border-edge-strong px-2 py-0.5 text-xs font-medium text-ink-strong">
            {copy.unread}
          </span>
        )}
      </div>

      {/* The event type is metadata, shown as the token it is. Left to right in every locale: it is an
          identifier, not a sentence, and an RTL run would reorder its dotted segments. */}
      <p dir="ltr" className="mt-2 break-all font-mono text-xs text-ink-muted">
        {item.eventType}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <time dateTime={item.createdAt} className="text-xs text-ink-muted">
          {item.createdAt.slice(0, 10)}
        </time>
        {item.actionPath !== null && (
          <Link
            href={`${localePrefix}${item.actionPath}`}
            className="text-sm underline underline-offset-4"
          >
            {copy.open}
          </Link>
        )}
        <NotificationActions id={item.id} isUnread={isUnread} isArchived={item.archivedAt !== null} copy={copy.actions} />
      </div>
    </li>
  );
}

/** The list itself. A plain `<ul>`, so it is navigable without JavaScript and announced as a list. */
export function NotificationList({
  items,
  copy,
  localePrefix,
  label,
}: {
  readonly items: readonly NotificationItem[];
  readonly copy: NotificationCopy;
  readonly localePrefix: string;
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="mt-8 space-y-3">
      {items.map((item) => (
        <NotificationRow key={item.id} item={item} copy={copy} localePrefix={localePrefix} />
      ))}
    </ul>
  );
}
