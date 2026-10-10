import { cx } from './recipes.js';

/**
 * A placeholder with the shape of the thing that is loading.
 *
 * The pulse is one keyframe defined once in `globals.css`, so every loading surface in the product breathes at
 * the same rate — and it stops entirely under `prefers-reduced-motion`, which is fine, because the shape alone
 * already says "not yet".
 *
 * `rounded-md`, the control radius, rather than `full`: a skeleton stands in for text and boxes, and a pill-shaped
 * block reads as a badge that never arrived.
 */
export function Skeleton({ className }: { readonly className?: string }) {
  return <span aria-hidden="true" className={cx('block rounded-md bg-surface-muted mp-pulse', className)} />;
}

/**
 * A few lines of text, loading.
 *
 * The last line is short, because real paragraphs end mid-measure and a block of equal-length bars reads as a
 * table rather than as prose.
 */
export function SkeletonText({ lines = 3, className }: { readonly lines?: number; readonly className?: string }) {
  return (
    <span aria-hidden="true" className={cx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cx('h-4', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </span>
  );
}

/**
 * A catalogue card, loading.
 *
 * It matches {@link LinkCard}'s real geometry exactly — the same border, a two-line title block, and a price line
 * pinned to the bottom — and like the real card it has no media area, because the browse contract has no image
 * field. That exactness is the point of a skeleton rather than a spinner here: the grid does not move when the
 * data arrives, so a person's eye stays where it was.
 */
export function SkeletonCard() {
  return (
    <div className="flex min-h-40 flex-col rounded-lg border border-hairline bg-surface-raised p-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <div className="mt-auto flex items-end justify-between pt-6">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-16" />
      </div>
    </div>
  );
}

/**
 * A grid of loading cards.
 *
 * The column counts are the catalogue's, so the skeleton and the result share one responsive rhythm. Twelve is
 * the default because that is a full first page of results.
 *
 * The whole grid is one `role="status"` with a single accessible label: a screen reader should hear "Loading
 * results" once, not twelve times.
 */
export function SkeletonCardGrid({ count = 12, label }: { readonly count?: number; readonly label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}
