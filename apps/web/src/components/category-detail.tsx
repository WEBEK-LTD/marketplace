import type { CategoryDetail } from '@repo/contracts';

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
        <p className="text-sm text-neutral-600">
          <span>{labels.parentHeading} </span>
          <a
            href={hrefFor(category.parent.slug)}
            className="underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900"
          >
            {category.parent.name}
          </a>
        </p>
      )}

      <h1 className="mt-2 text-3xl font-semibold text-neutral-900">{category.name}</h1>
      {category.description === null ? null : (
        <p className="mt-2 max-w-prose text-neutral-600">{category.description}</p>
      )}

      <h2 className="mt-10 text-lg font-semibold text-neutral-900">{labels.subcategoriesHeading}</h2>

      {category.children.length === 0 ? (
        <div role="status" className="mt-4 rounded-lg border border-neutral-200 p-8 text-center">
          <p className="text-base font-medium text-neutral-900">{labels.emptyChildrenTitle}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-600">{labels.emptyChildren}</p>
        </div>
      ) : (
        <ul
          aria-label={labels.subcategoriesHeading}
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {category.children.map((child) => (
            <li key={child.id} className="rounded-lg border border-neutral-200">
              <a
                href={hrefFor(child.slug)}
                className="block px-4 py-3 text-neutral-900 underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900"
              >
                {child.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
