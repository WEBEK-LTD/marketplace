import { ButtonLink } from './button.js';
import { cx, TYPE } from './recipes.js';

export interface PaginationProps {
  /** Where the next page lives, or null when this is the last one. */
  readonly nextHref: string | null;
  /** The catalogue's first page, shown as a way back once a cursor is in the URL. */
  readonly firstHref: string;
  /** Whether a cursor is currently in the URL, i.e. this is not the first page. */
  readonly paged: boolean;
  readonly labels: {
    readonly next: string;
    readonly first: string;
    /**
     * A sentence stating what is on screen, with the count already interpolated.
     *
     * Omitted on a surface that already states its count above the grid — `CatalogToolbar` does, and saying "8
     * results" at both ends of the same list is noise rather than context.
     */
    readonly position?: string;
    readonly navigation: string;
  };
  readonly className?: string;
}

/**
 * Moving through a catalogue.
 *
 * **There are no page numbers, and that is the data contract rather than a shortcut.** Every paginated reader in
 * this product returns `{ items, nextCursor }` — a forward-only opaque cursor, with no total and no offset. A
 * numbered pager would therefore have to invent two things it cannot know: how many pages exist, and how to jump
 * to the fifth. Drawing `1 2 3 … 47` from a cursor API means either lying or firing forty-seven requests, so
 * this component offers what the contract actually supports:
 *
 *   * **Next**, when there is a next cursor.
 *   * **A way back to the start**, once a cursor is in the URL — because a forward-only cursor has no "previous",
 *     and a person who has paged four times wants the beginning far more often than they want step three. The
 *     browser's back button already does the single step, correctly, and better than we could.
 *   * **A statement of what is on screen**, so the control is not two bare buttons with no context — unless
 *     the surface states its count above the grid already, in which case the sentence is omitted rather than
 *     repeated.
 *
 * Both controls are links, so a page of results has a URL that can be shared, bookmarked and crawled, and paging
 * works with JavaScript unavailable.
 *
 * Nothing is rendered when there is one page and no cursor: an empty pager under a short list is noise.
 */
export function Pagination({ nextHref, firstHref, paged, labels, className }: PaginationProps) {
  if (nextHref === null && !paged) return null;
  return (
    <nav
      aria-label={labels.navigation}
      className={cx(
        'flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-6',
        labels.position === undefined ? 'justify-end' : 'justify-between',
        className,
      )}
    >
      {labels.position === undefined ? null : (
        <p className={TYPE.meta} aria-live="polite">
          {labels.position}
        </p>
      )}
      <div className="flex items-center gap-2">
        {paged ? (
          <ButtonLink href={firstHref} variant="ghost" size="sm">
            {labels.first}
          </ButtonLink>
        ) : null}
        {nextHref === null ? null : (
          /*
            `rel="next"` is part of the contract, not decoration: it tells a crawler that this is a sequence
            rather than a set of near-duplicate pages, and the public route tests pin it on every paginated
            surface. The component sets it so no caller can forget it.
          */
          <ButtonLink href={nextHref} variant="secondary" size="sm" rel="next">
            {labels.next}
          </ButtonLink>
        )}
      </div>
    </nav>
  );
}
