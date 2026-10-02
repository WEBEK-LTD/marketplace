import type { CategoryNode } from '@repo/contracts';

/**
 * The public category tree and the three states that go with it (Phase 4-A).
 *
 * All four exports render on the server: the tree is content, not interaction, so nothing here needs to
 * ship JavaScript to the browser. That also means the names are in the HTML a crawler receives.
 *
 * **Why headings and nested lists.** The database limits the tree to three levels (D8), which maps
 * exactly onto a heading per top-level category and a nested list beneath it. Each nested list is
 * associated with its heading through `aria-labelledby`, so a screen reader announces "Electronics,
 * list, 4 items" rather than an unlabelled list adrift on the page.
 *
 * **No links yet.** A category has nowhere to go until listings exist; a link to a page that returns 404
 * would be worse than plain text. The names render as text, and the link lands with the listings slice.
 *
 * **Direction is never hard-coded.** Spacing and alignment use logical properties, so the same markup
 * reads correctly left-to-right in English and right-to-left in Arabic with nothing but `dir` changing.
 */

export interface CategoryTreeProps {
  readonly nodes: readonly CategoryNode[];
}

/** One top-level category and everything beneath it. */
function CategorySection({ node }: { readonly node: CategoryNode }) {
  const headingId = `category-${node.id}`;
  return (
    <section className="rounded-lg border border-neutral-200 p-5">
      <h2 id={headingId} className="text-lg font-semibold text-neutral-900">
        {node.name}
      </h2>
      {node.children.length > 0 ? (
        <ul aria-labelledby={headingId} className="mt-3 space-y-2">
          {node.children.map((child) => (
            <li key={child.id}>
              <span className="text-neutral-800">{child.name}</span>
              {child.children.length > 0 ? (
                <ul className="mt-1 space-y-1 border-neutral-200 ps-4 text-sm text-neutral-600 border-s">
                  {child.children.map((grandchild) => (
                    <li key={grandchild.id}>{grandchild.name}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The tree itself.
 *
 * One column on a phone, two from the small breakpoint and three from the large one — the categories
 * are independent of each other, so they reflow without losing meaning.
 */
export function CategoryTree({ nodes }: CategoryTreeProps) {
  return (
    <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {nodes.map((node) => (
        <CategorySection key={node.id} node={node} />
      ))}
    </div>
  );
}

/**
 * The loading state.
 *
 * Placeholders in the shape of the real thing, so the page does not jump when the content arrives.
 * `aria-busy` with a visible label tells a screen reader that something is on its way; the placeholder
 * boxes themselves are hidden from the accessibility tree, because "three empty rectangles" is noise.
 */
export function CategoryTreeSkeleton({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="mt-8">
      <p className="text-sm text-neutral-600">{label}</p>
      <div aria-hidden="true" className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((slot) => (
          <div key={slot} className="rounded-lg border border-neutral-200 p-5">
            <div className="h-5 w-1/2 rounded bg-neutral-200" />
            <div className="mt-4 h-3 w-3/4 rounded bg-neutral-100" />
            <div className="mt-2 h-3 w-2/3 rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The empty and error states, which differ only in what they say and how loudly.
 *
 * An empty catalogue is ordinary: `role="status"` announces it politely. A catalogue that could not be
 * read is a failure the visitor should hear about promptly, so it is a `role="alert"`. Neither invents a
 * next step — there is no retry control, because nothing on this page has an action to retry.
 */
export function CategoryTreeMessage({
  title,
  description,
  tone,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone: 'empty' | 'error';
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="mt-8 rounded-lg border border-neutral-200 p-8 text-center"
    >
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-600">{description}</p>
    </div>
  );
}
