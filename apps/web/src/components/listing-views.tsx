import type { ListingDetail, ListingSummary } from '@repo/contracts';
import { ListingPrice, type ListingPriceLabels } from './listing-price';

/**
 * The public listing surfaces (Phase 4-B).
 *
 * Everything renders on the server: a listing is content, and a crawler and a visitor with no
 * JavaScript should both see it. Nothing here ships an image — variant sizes and formats are still an
 * open decision, so there is no media UI to build yet, and a placeholder box would be inventing one.
 *
 * Direction is never hard-coded. Spacing and alignment use logical properties, so the same markup reads
 * correctly in English and in Arabic with nothing but `dir` changing.
 */

export interface ListingCardLabels extends ListingPriceLabels {
  readonly noLongerAvailable?: string;
}

/** One card in the browse list. A card names the listing and its price, and nothing more. */
export function ListingCard({
  listing,
  href,
  labels,
}: {
  readonly listing: ListingSummary;
  readonly href: string;
  readonly labels: ListingCardLabels;
}) {
  return (
    <li className="rounded-lg border border-neutral-200 p-5">
      <h2 className="text-base font-medium text-neutral-900">
        <a href={href} className="underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900">
          {listing.title}
        </a>
      </h2>
      {listing.city === null ? null : <p className="mt-1 text-sm text-neutral-600">{listing.city}</p>}
      <ListingPrice
        priceMinor={listing.priceMinor}
        currencyCode={listing.currencyCode}
        currencyMinorUnit={listing.currencyMinorUnit}
        isNegotiable={listing.isNegotiable}
        labels={labels}
      />
    </li>
  );
}

/** The browse list: one column on a phone, two from small, three from large. */
export function ListingGrid({
  listings,
  hrefFor,
  labels,
}: {
  readonly listings: readonly ListingSummary[];
  readonly hrefFor: (slug: string) => string;
  readonly labels: ListingCardLabels;
}) {
  return (
    <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {listings.map((listing) => (
        <ListingCard key={listing.id} listing={listing} href={hrefFor(listing.slug)} labels={labels} />
      ))}
    </ul>
  );
}

/**
 * The loading state.
 *
 * Placeholders shaped like the cards, so the page does not jump when the real ones arrive. `aria-busy`
 * with a visible label announces the wait; the boxes themselves are hidden from assistive technology.
 */
export function ListingGridSkeleton({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="mt-8">
      <p className="text-sm text-neutral-600">{label}</p>
      <div aria-hidden="true" className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((slot) => (
          <div key={slot} className="rounded-lg border border-neutral-200 p-5">
            <div className="h-4 w-3/4 rounded bg-neutral-200" />
            <div className="mt-3 h-3 w-1/3 rounded bg-neutral-100" />
            <div className="mt-4 h-4 w-1/2 rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The empty, error and not-found states.
 *
 * An empty catalogue is ordinary, so it is announced politely; a failure is an alert. Neither invents a
 * next step, because the page has no action to offer.
 */
export function ListingMessage({
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

export interface ListingDetailLabels extends ListingPriceLabels {
  readonly noLongerAvailable: string;
  readonly sellerHeading: string;
  readonly categoryHeading: string;
  readonly detailsHeading: string;
  readonly tagsHeading: string;
  readonly descriptionHeading: string;
  readonly yes: string;
  readonly no: string;
}

/** Renders one attribute's value in the shape the attribute actually has. */
function attributeValue(
  attribute: ListingDetail['attributes'][number],
  labels: ListingDetailLabels,
): string {
  if (attribute.options.length > 0) return attribute.options.join(', ');
  if (attribute.boolean !== null) return attribute.boolean ? labels.yes : labels.no;
  if (attribute.text === null) return '';
  return attribute.unit === null ? attribute.text : `${attribute.text} ${attribute.unit}`;
}

/**
 * The detail page's body.
 *
 * `content_language` is set on the title and description, because seller content is stored in its own
 * writing language and never translated (D7): a page in Arabic may carry an English listing, and a
 * screen reader should switch voice for it rather than read it in the page's language.
 */
export function ListingDetailView({
  listing,
  labels,
}: {
  readonly listing: ListingDetail;
  readonly labels: ListingDetailLabels;
}) {
  const unavailable = listing.availability === 'no_longer_available';

  return (
    <article className="mt-6">
      {unavailable ? (
        <p role="status" className="rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-900">
          {labels.noLongerAvailable}
        </p>
      ) : null}

      <h1 lang={listing.contentLanguage} className="mt-4 text-2xl font-semibold text-neutral-900">
        {listing.title}
      </h1>
      {listing.city === null ? null : <p className="mt-1 text-neutral-600">{listing.city}</p>}

      <ListingPrice
        priceMinor={listing.priceMinor}
        currencyCode={listing.currencyCode}
        currencyMinorUnit={listing.currencyMinorUnit}
        isNegotiable={listing.isNegotiable}
        labels={labels}
      />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-neutral-900">{labels.descriptionHeading}</h2>
          <p lang={listing.contentLanguage} className="mt-2 whitespace-pre-line text-neutral-800">
            {listing.description}
          </p>

          {listing.attributes.length > 0 ? (
            <>
              <h2 className="mt-8 text-lg font-semibold text-neutral-900">{labels.detailsHeading}</h2>
              <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                {listing.attributes.map((attribute) => (
                  <div key={attribute.key} className="flex justify-between gap-4 border-b border-neutral-100 py-2">
                    <dt className="text-sm text-neutral-600">{attribute.label}</dt>
                    <dd className="text-sm text-neutral-900">{attributeValue(attribute, labels)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </div>

        <aside className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold text-neutral-900">{labels.sellerHeading}</h2>
            <p className="mt-1 text-neutral-800">{listing.seller.displayName}</p>
          </section>
          <section>
            <h2 className="text-sm font-semibold text-neutral-900">{labels.categoryHeading}</h2>
            <p className="mt-1 text-neutral-800">{listing.category.name}</p>
          </section>
          {listing.tags.length > 0 ? (
            <section>
              <h2 className="text-sm font-semibold text-neutral-900">{labels.tagsHeading}</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {listing.tags.map((tag) => (
                  <li key={tag.slug} className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700">
                    {tag.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
