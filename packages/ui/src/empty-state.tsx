import type { ReactNode } from 'react';
import { cx, TYPE } from './recipes.js';

export type EmptyTone = 'empty' | 'unavailable';

export interface EmptyStateProps {
  /** What the person is looking at. A statement, not an apology. */
  readonly title: string;
  /** Why it is empty, and what to do next. One or two sentences. */
  readonly description?: string;
  /** The action that resolves it — clear the filters, browse everything, try again. */
  readonly action?: ReactNode;
  /**
   * `empty` means the query succeeded and matched nothing — a person's filters are too narrow, or a new seller
   * has no listings yet. `unavailable` means the product could not answer — the API is unreachable, a reader
   * returned an outage. The two look different because they are different, and a person's next move differs too.
   */
  readonly tone?: EmptyTone;
  /**
   * The heading level the title renders at.
   *
   * `h2` is right when this sits inside a page that already has an `h1` — an empty catalogue under a page title.
   * `h1` is right when the empty state **is** the page, which is what a 404 is: its title is the document's own
   * heading, and demoting it would leave the page with no `h1` at all.
   */
  readonly as?: 'h1' | 'h2';
  readonly className?: string;
}

/**
 * The state a surface is in when it has nothing to show.
 *
 * **This is the increment's answer to missing backend data.** Where a reader has no rows, or cannot reach the
 * API at all, the product shows one of these rather than placeholder listings — fake production data is the one
 * thing a marketplace must never render, because a person cannot tell it from the real thing.
 *
 * The two tones are drawn apart deliberately:
 *
 *   * **`empty`** — a dashed border on the page surface. A dashed edge reads as a space waiting to be filled,
 *     which is exactly what it is, and it is visibly not a card that failed to load.
 *   * **`unavailable`** — a solid hairline on a recessed well. A person did nothing wrong, so nothing here is
 *     phrased as if they did.
 *
 * **Both tones are announced, at the severity they deserve.** A result set that came back empty is `role="status"`
 * with a polite live region: somebody who narrowed a filter and got nothing has to learn that without watching the
 * screen. An outage is `role="alert"`, which interrupts — the page cannot answer, and that is worth interrupting
 * for. This split is the one the catalogue surfaces have always used and 0109 keeps it exactly.
 *
 * The copy rules are the point as much as the shape: an empty screen is an invitation to act, so the title names
 * the situation and the action offers the way out. No apology, no "oops", and never vague about what happened.
 */
export function EmptyState({ title, description, action, tone = 'empty', as: Tag = 'h2', className }: EmptyStateProps) {
  return (
    <div
      role={tone === 'unavailable' ? 'alert' : 'status'}
      aria-live={tone === 'unavailable' ? 'assertive' : 'polite'}
      className={cx(
        'flex flex-col items-center justify-center gap-3 rounded-lg px-6 py-14 text-center',
        tone === 'empty'
          ? 'border border-dashed border-edge-brand bg-surface-sunken'
          : 'border border-hairline bg-surface-muted',
        className,
      )}
    >
      <EmptyMark tone={tone} />
      <Tag className={Tag === 'h1' ? TYPE.h2 : TYPE.h4}>{title}</Tag>
      {description === undefined ? null : (
        <p className={cx(TYPE.body, 'max-w-prose text-balance')}>{description}</p>
      )}
      {action === undefined ? null : <div className="pt-1">{action}</div>}
    </div>
  );
}

/**
 * The mark above the title.
 *
 * An empty frame for `empty` — the shape of a thing that is not there — and the same frame crossed through for
 * `unavailable`. Both drawn from borders, both `aria-hidden`: the heading says what this is.
 */
function EmptyMark({ tone }: { readonly tone: EmptyTone }) {
  return (
    <span aria-hidden="true" className="relative block size-12 rounded-xl border-2 border-dashed border-edge-brand">
      {tone === 'unavailable' ? (
        <span className="absolute top-1/2 start-[-4px] h-0.5 w-12 -rotate-45 bg-edge" />
      ) : null}
    </span>
  );
}

/**
 * A compact empty state, for inside a card or a panel.
 *
 * The full {@link EmptyState} is too tall for a sidebar or a tab panel, and a surface that has nothing to say
 * still has to say it. Same voice, one line.
 */
export function EmptyLine({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <p className={cx('rounded-lg border border-dashed border-edge-brand bg-surface-sunken px-4 py-6 text-center text-sm text-ink-muted', className)}>
      {children}
    </p>
  );
}
