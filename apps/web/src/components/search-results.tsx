import type { SearchResult } from '@repo/contracts';
import { ListingClickBeacon } from './listing-beacon';
import { ListingCard, type ListingCardLabels } from './listing-views';
import { ServiceCard, type ServiceLabels } from './service-views';

/**
 * The public search result list (Phase 4-F, V1).
 *
 * Results are mixed, and each one is rendered by the card its own surface already owns: a listing result
 * by `ListingCard`, a service result by `ServiceCard`. Nothing is flattened into a common card, because
 * the two genuinely differ — a service carries delivery time and revisions, a listing carries
 * negotiability — and a person scanning results is better served by seeing what each thing actually is.
 *
 * The `type` discriminator does the choosing, so an unrecognised shape cannot reach a card at all: the
 * contract refuses it before this component sees it.
 */

export interface SearchLabels {
  readonly listing: ListingCardLabels;
  readonly service: ServiceLabels;
}

export function SearchResultList({
  results,
  listingHref,
  serviceHref,
  labels,
}: {
  readonly results: readonly SearchResult[];
  readonly listingHref: (slug: string) => string;
  readonly serviceHref: (slug: string) => string;
  readonly labels: SearchLabels;
}) {
  return (
    // 0101: one listener for the whole list, emitting a click for whichever listing was opened from here.
    <ListingClickBeacon source="search">
      <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((result) =>
          result.type === 'service' ? (
            <ServiceCard
              key={`service-${result.id}`}
              service={result}
              href={serviceHref(result.slug)}
              labels={labels.service}
            />
          ) : (
            <ListingCard
              key={`listing-${result.id}`}
              listing={result}
              href={listingHref(result.slug)}
              labels={labels.listing}
            />
          ),
        )}
      </ul>
    </ListingClickBeacon>
  );
}

/**
 * The search form.
 *
 * A plain `GET` form, so a search is a URL: shareable, bookmarkable, reloadable, and working before any
 * JavaScript arrives. `type="search"` gives the field its expected keyboard and clear affordance, and the
 * label is real rather than a placeholder standing in for one.
 */
export function SearchForm({
  action,
  query,
  labels,
}: {
  readonly action: string;
  readonly query: string;
  readonly labels: { readonly label: string; readonly placeholder: string; readonly submit: string };
}) {
  return (
    <form action={action} method="get" role="search" className="mt-6 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor="search-q" className="block text-sm font-medium text-ink-strong">
          {labels.label}
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={labels.placeholder}
          className="mt-1 w-full rounded-md border border-edge px-3 py-2 text-ink-strong"
        />
      </div>
      <button
        type="submit"
        className="rounded-md border border-edge-strong bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink"
      >
        {labels.submit}
      </button>
    </form>
  );
}
