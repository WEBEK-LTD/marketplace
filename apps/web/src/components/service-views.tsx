import type { ServiceDetail, ServiceSummary } from '@repo/contracts';
import { ListingPrice, type ListingPriceLabels } from './listing-price';
import { ListingMessage } from './listing-views';

/**
 * The public service surfaces (Phase 4-C).
 *
 * Built on the listing components where the two surfaces genuinely agree — the price states and the
 * empty/error message are the same problem — and diverging where a service is not a product: how it is
 * priced, how long it takes, how many revisions it includes, whether it needs a brief, what it covers.
 *
 * Everything renders on the server, and nothing here ships an image: variant sizes and formats are still
 * an open decision, so there is no media UI to build yet.
 *
 * Direction is never hard-coded. Spacing and alignment use logical properties, so the same markup reads
 * correctly in English and in Arabic with nothing but `dir` changing.
 */

export interface ServiceLabels extends ListingPriceLabels {
  readonly fixedPrice: string;
  readonly customPricing: string;
  readonly deliveryTime: string;
  readonly revisionsIncluded: string;
  /** Already pluralized by the caller, which is where the locale lives. */
  readonly deliveryDays: (count: number) => string;
}

/** The pricing model, in words, or nothing when the seller recorded none. */
function pricingLabel(
  pricingModel: ServiceSummary['pricingModel'],
  labels: ServiceLabels,
): string | null {
  if (pricingModel === 'fixed') return labels.fixedPrice;
  if (pricingModel === 'custom') return labels.customPricing;
  return null;
}

/** A small labelled fact — delivery time, revisions — shown only when the service states one. */
function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-100 py-2">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-sm text-neutral-900">{value}</dd>
    </div>
  );
}

/** One card in the service list. */
export function ServiceCard({
  service,
  href,
  labels,
}: {
  readonly service: ServiceSummary;
  readonly href: string;
  readonly labels: ServiceLabels;
}) {
  const pricing = pricingLabel(service.pricingModel, labels);

  return (
    <li className="rounded-lg border border-neutral-200 p-5">
      <h2 className="text-base font-medium text-neutral-900">
        <a href={href} className="underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900">
          {service.title}
        </a>
      </h2>
      {service.city === null ? null : <p className="mt-1 text-sm text-neutral-600">{service.city}</p>}
      <ListingPrice
        priceMinor={service.priceMinor}
        currencyCode={service.currencyCode}
        currencyMinorUnit={service.currencyMinorUnit}
        isNegotiable={false}
        labels={labels}
      />
      {pricing === null ? null : (
        <p className="mt-2">
          <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-700">
            {pricing}
          </span>
        </p>
      )}
      {service.deliveryDays === null && service.revisionsIncluded === null ? null : (
        <dl className="mt-3">
          {service.deliveryDays === null ? null : (
            <Fact label={labels.deliveryTime} value={labels.deliveryDays(service.deliveryDays)} />
          )}
          {service.revisionsIncluded === null ? null : (
            <Fact label={labels.revisionsIncluded} value={String(service.revisionsIncluded)} />
          )}
        </dl>
      )}
    </li>
  );
}

/** The service list: one column on a phone, two from small, three from large. */
export function ServiceGrid({
  services,
  hrefFor,
  labels,
}: {
  readonly services: readonly ServiceSummary[];
  readonly hrefFor: (slug: string) => string;
  readonly labels: ServiceLabels;
}) {
  return (
    <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} href={hrefFor(service.slug)} labels={labels} />
      ))}
    </ul>
  );
}

/** The loading state: placeholders shaped like the cards, so the page does not jump. */
export function ServiceGridSkeleton({ label }: { readonly label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="mt-8">
      <p className="text-sm text-neutral-600">{label}</p>
      <div aria-hidden="true" className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((slot) => (
          <div key={slot} className="rounded-lg border border-neutral-200 p-5">
            <div className="h-4 w-3/4 rounded bg-neutral-200" />
            <div className="mt-3 h-3 w-1/3 rounded bg-neutral-100" />
            <div className="mt-4 h-4 w-1/2 rounded bg-neutral-100" />
            <div className="mt-4 h-3 w-2/3 rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The empty, error and not-found states share the listing surface's message component. */
export { ListingMessage as ServiceMessage };

export interface ServiceDetailLabels extends ServiceLabels {
  readonly noLongerAvailable: string;
  readonly requiresBrief: string;
  readonly scope: string;
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
  attribute: ServiceDetail['attributes'][number],
  labels: ServiceDetailLabels,
): string {
  if (attribute.options.length > 0) return attribute.options.join(', ');
  if (attribute.boolean !== null) return attribute.boolean ? labels.yes : labels.no;
  if (attribute.text === null) return '';
  return attribute.unit === null ? attribute.text : `${attribute.text} ${attribute.unit}`;
}

/**
 * The service detail page's body.
 *
 * `content_language` is set on the title, description and scope, because seller content is stored in its
 * own writing language and never translated (D7): a page in Arabic may carry an English service, and a
 * screen reader should switch voice for it rather than read it in the page's language.
 */
export function ServiceDetailView({
  service,
  labels,
}: {
  readonly service: ServiceDetail;
  readonly labels: ServiceDetailLabels;
}) {
  const unavailable = service.availability === 'no_longer_available';
  const pricing = pricingLabel(service.pricingModel, labels);

  return (
    <article className="mt-6">
      {unavailable ? (
        <p
          role="status"
          className="rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-900"
        >
          {labels.noLongerAvailable}
        </p>
      ) : null}

      <h1 lang={service.contentLanguage} className="mt-4 text-2xl font-semibold text-neutral-900">
        {service.title}
      </h1>
      {service.city === null ? null : <p className="mt-1 text-neutral-600">{service.city}</p>}

      <ListingPrice
        priceMinor={service.priceMinor}
        currencyCode={service.currencyCode}
        currencyMinorUnit={service.currencyMinorUnit}
        isNegotiable={false}
        labels={labels}
      />
      {pricing === null ? null : (
        <p className="mt-2">
          <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-700">
            {pricing}
          </span>
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-neutral-900">{labels.descriptionHeading}</h2>
          <p lang={service.contentLanguage} className="mt-2 whitespace-pre-line text-neutral-800">
            {service.description}
          </p>

          {service.scope === null ? null : (
            <>
              <h2 className="mt-8 text-lg font-semibold text-neutral-900">{labels.scope}</h2>
              <p lang={service.contentLanguage} className="mt-2 whitespace-pre-line text-neutral-800">
                {service.scope}
              </p>
            </>
          )}

          {service.attributes.length > 0 ? (
            <>
              <h2 className="mt-8 text-lg font-semibold text-neutral-900">{labels.detailsHeading}</h2>
              <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                {service.attributes.map((attribute) => (
                  <Fact
                    key={attribute.key}
                    label={attribute.label}
                    value={attributeValue(attribute, labels)}
                  />
                ))}
              </dl>
            </>
          ) : null}
        </div>

        <aside className="space-y-6">
          {service.deliveryDays === null &&
          service.revisionsIncluded === null &&
          service.requiresBrief === null ? null : (
            <dl>
              {service.deliveryDays === null ? null : (
                <Fact label={labels.deliveryTime} value={labels.deliveryDays(service.deliveryDays)} />
              )}
              {service.revisionsIncluded === null ? null : (
                <Fact label={labels.revisionsIncluded} value={String(service.revisionsIncluded)} />
              )}
              {service.requiresBrief === null ? null : (
                <Fact
                  label={labels.requiresBrief}
                  value={service.requiresBrief ? labels.yes : labels.no}
                />
              )}
            </dl>
          )}
          <section>
            <h2 className="text-sm font-semibold text-neutral-900">{labels.sellerHeading}</h2>
            <p className="mt-1 text-neutral-800">{service.seller.displayName}</p>
          </section>
          <section>
            <h2 className="text-sm font-semibold text-neutral-900">{labels.categoryHeading}</h2>
            <p className="mt-1 text-neutral-800">{service.category.name}</p>
          </section>
          {service.tags.length > 0 ? (
            <section>
              <h2 className="text-sm font-semibold text-neutral-900">{labels.tagsHeading}</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {service.tags.map((tag) => (
                  <li
                    key={tag.slug}
                    className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700"
                  >
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
