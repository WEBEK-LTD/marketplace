import type { CategoryDetail } from '@repo/contracts';
import { CategoryRow } from './catalog-card';

/**
 * The public category landing page's body (Phase 4-D).
 *
 * A category page in V1 is a place in the catalogue, not a feed: a title, the description the admin
 * wrote, and the way further in. There are deliberately no listing or service cards — category-to-listing
 * discovery belongs to a later increment — and no counts, sorts or filters.
 *
 * Direction is never hard-coded. Spacing uses logical properties, so the same markup reads correctly in
 * English and in Arabic with nothing but `dir` changing.
 */

export interface CategoryLabels {
  readonly subcategoriesHeading: string;
  readonly emptyChildrenTitle: string;
  readonly emptyChildren: string;
  readonly parentHeading: string;
}

export function CategoryDetailView({
  category,
  hrefFor,
  labels,
}: {
  readonly category: CategoryDetail;
  readonly hrefFor: (slug: string) => string;
  readonly labels: CategoryLabels;
}) {
  return (
    <div>
      {category.parent === null ? null : (
        <p className="text-sm text-ink-muted">
          <span>{labels.parentHeading} </span>
          <a
            href={hrefFor(category.parent.slug)}
            className="underline decoration-edge underline-offset-4 hover:decoration-ink-strong"
          >
            {category.parent.name}
          </a>
        </p>
      )}

      <h1 className="mt-2 text-3xl font-semibold text-ink-strong">{category.name}</h1>
      {category.description === null ? null : (
        <p className="mt-2 max-w-prose text-ink-muted">{category.description}</p>
      )}

      <h2 className="mt-10 text-lg font-semibold text-ink-strong">{labels.subcategoriesHeading}</h2>

      {category.children.length === 0 ? (
        <div role="status" className="mt-4 rounded-lg border border-hairline p-8 text-center">
          <p className="text-base font-medium text-ink-strong">{labels.emptyChildrenTitle}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{labels.emptyChildren}</p>
        </div>
      ) : (
        /*
          An index, not a grid of outlined boxes (0112). This drew one bordered rectangle per subcategory, three
          across, each holding an underlined word — the same figure the home page's category block was rejected
          for, and on a phone a column of four tall empty boxes before the reader reaches a single result. It is
          the same component the home page uses now, so a category reads the same way wherever it is offered.
        */
        <ul
          aria-label={labels.subcategoriesHeading}
          className="mt-4 list-none border-t border-hairline sm:columns-2 sm:gap-x-16 [&>li]:break-inside-avoid"
        >
          {category.children.map((child) => (
            <CategoryRow key={child.id} href={hrefFor(child.slug)} label={child.name} />
          ))}
        </ul>
      )}
    </div>
  );
}
