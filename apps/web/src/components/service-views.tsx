import type { ServiceDetail, ServiceSummary } from '@repo/contracts';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Card,
  CardGrid,
  DetailLayout,
  DetailList,
  EmptyState,
  Heading,
  SkeletonCardGrid,
  TYPE,
  cx,
} from '@repo/ui';
import { CatalogCard } from './catalog-card';
import { type ListingPriceLabels, PriceLockup } from './listing-price';

/**
 * The public service surfaces (Phase 4-B, restyled in 0109).
 *
 * Everything renders on the server: a service is content, and a crawler and a visitor with no JavaScript should
 * both see it. Nothing here ships an image, for the same reason the listing surfaces do not — the browse contract
 * carries no media field.
 *
 * Direction is never hard-coded. Spacing and alignment use logical properties, so the same markup reads correctly
 * in English and in Arabic with nothing but `dir` changing.
 *
 * **A service card is the same card as a listing card.** Both are {@link CatalogCard}, which is what makes a
 * mixed grid — the marketplace landing, a search result list — read as one catalogue rather than as two lists
 * that happen to be stacked. What differs is only what a service has to say: a pricing model, a delivery time.
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
function pricingLabel(pricingModel: ServiceSummary['pricingModel'], labels: ServiceLabels): string | null {
  if (pricingModel === 'fixed') return labels.fixedPrice;
  if (pricingModel === 'custom') return labels.customPricing;
  return null;
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
  /**
   * The facts the card states, and only the ones this service actually recorded.
   *
   * Both the delivery time and the revisions appear, as they did before 0109 — a buyer comparing services uses
   * both, so dropping one to make the card tidier would be taking information away. They are a description list
   * rather than a line joined by a separator character, which is the same reason the rest of the product gave up
   * the middle-dot meta string: a screen reader reads a real `<dl>` as pairs, and the layout mirrors itself.
   */
  const facts = [
    ...(service.deliveryDays === null
      ? []
      : [{ label: labels.deliveryTime, value: labels.deliveryDays(service.deliveryDays) }]),
    ...(service.revisionsIncluded === null
      ? []
      : [{ label: labels.revisionsIncluded, value: String(service.revisionsIncluded) }]),
  ];

  return (
    <CatalogCard
      href={href}
      title={service.title}
      city={service.city}
      priceMinor={service.priceMinor}
      currencyCode={service.currencyCode}
      currencyMinorUnit={service.currencyMinorUnit}
      /* A service is not a negotiable thing: the field does not exist on the contract. */
      isNegotiable={null}
      labels={labels}
      {...(pricing === null ? {} : { badge: { label: pricing, tone: 'neutral' as const } })}
      {...(facts.length === 0
        ? {}
        : {
            meta: (
              <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {facts.map((fact) => (
                  <div key={fact.label} className="flex items-baseline gap-1.5">
                    <dt className="text-ink-muted">{fact.label}</dt>
                    <dd className="font-medium text-ink-body">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ),
          })}
    />
  );
}

/** The service list, on the catalogue's shared responsive rhythm. */
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
    <CardGrid className="mt-8">
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} href={hrefFor(service.slug)} labels={labels} />
      ))}
    </CardGrid>
  );
}

/** The loading state: placeholders shaped like the real cards, so the grid does not move. */
export function ServiceGridSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="mt-8">
      <SkeletonCardGrid count={8} label={label} />
    </div>
  );
}

/** The empty and unavailable states, drawn apart because a person's next move differs. */
export function ServiceMessage({
  title,
  description,
  tone,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone: 'empty' | 'error';
}) {
  return (
    <div className="mt-8">
      <EmptyState title={title} description={description} tone={tone === 'error' ? 'unavailable' : 'empty'} />
    </div>
  );
}

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
function attributeValue(attribute: ServiceDetail['attributes'][number], labels: ServiceDetailLabels): string {
  if (attribute.options.length > 0) return attribute.options.join(', ');
  if (attribute.boolean !== null) return attribute.boolean ? labels.yes : labels.no;
  if (attribute.text === null) return '';
  return attribute.unit === null ? attribute.text : `${attribute.text} ${attribute.unit}`;
}

/**
 * The service detail page's body.
 *
 * **`contentLanguage` is set on the title, description and scope**, because seller content is stored in its own
 * writing language and never translated (D7): a page in Arabic may carry an English service, and a screen reader
 * should switch voice for it rather than read it in the page's language. `dir="auto"` goes with it, so content in
 * the other script is laid out the way it should be.
 *
 * The aside holds what a buyer judges a service by — the price, the pricing model, the delivery terms, the seller
 * — and sticks on a wide viewport while they read the scope. On a phone it comes first in the source order, so
 * none of that is below a long description.
 */
export function ServiceDetailView({
  service,
  labels,
  actions,
}: {
  readonly service: ServiceDetail;
  readonly labels: ServiceDetailLabels;
  /**
   * What a person came here to do, rendered under the price.
   *
   * A slot rather than markup, because the actions are the page's: they need a session, a listing id and a
   * client component, none of which belong in a presentational view. 0109 left them stranded at the foot of
   * the main column, half a screen below the price and under the description — the two halves of one decision
   * separated by everything else on the page. Here the price, the seller and the actions are one block.
   */
  readonly actions?: ReactNode;
}) {
  const unavailable = service.availability === 'no_longer_available';
  const pricing = pricingLabel(service.pricingModel, labels);

  /** The delivery terms, as a list, where the service states any. */
  const terms = [
    ...(service.deliveryDays === null
      ? []
      : [{ label: labels.deliveryTime, value: labels.deliveryDays(service.deliveryDays) }]),
    ...(service.revisionsIncluded === null
      ? []
      : [{ label: labels.revisionsIncluded, value: String(service.revisionsIncluded) }]),
    ...(service.requiresBrief === null
      ? []
      : [{ label: labels.requiresBrief, value: service.requiresBrief ? labels.yes : labels.no }]),
  ];

  return (
    <article className="pt-6 pb-12">
      {unavailable ? (
        <div className="mb-6">
          <Alert tone="warning" announce="polite" title={labels.noLongerAvailable} />
        </div>
      ) : null}

      <header className="mb-8">
        <Heading level={1}>
          <span lang={service.contentLanguage} dir="auto">
            {service.title}
          </span>
        </Heading>
        {service.city === null ? null : <p className={cx('mt-2', TYPE.meta)}>{service.city}</p>}
      </header>

      <DetailLayout
        main={
          <div className="space-y-10">
            <section>
              <h2 className={TYPE.h3}>{labels.descriptionHeading}</h2>
              <p
                lang={service.contentLanguage}
                dir="auto"
                className={cx('mt-3 max-w-prose whitespace-pre-line', TYPE.prose)}
              >
                {service.description}
              </p>
            </section>

            {service.scope === null ? null : (
              <section>
                <h2 className={TYPE.h3}>{labels.scope}</h2>
                <p
                  lang={service.contentLanguage}
                  dir="auto"
                  className={cx('mt-3 max-w-prose whitespace-pre-line', TYPE.prose)}
                >
                  {service.scope}
                </p>
              </section>
            )}

            {service.attributes.length > 0 ? (
              <section>
                <h2 className={TYPE.h3}>{labels.detailsHeading}</h2>
                <DetailList
                  className="mt-4"
                  items={service.attributes.map((attribute) => ({
                    label: attribute.label,
                    value: attributeValue(attribute, labels),
                  }))}
                />
              </section>
            ) : null}
          </div>
        }
        aside={
          <div className="space-y-4">
            {/*
              The buy box carries the brand surface and a brand edge. Everything else on a detail page is
              something to read; this is the one region that is something to do, and on a page of white
              panels it was indistinguishable from the panel of tags beneath it.
            */}
            <Card padding="lg" className="bg-surface-brand-soft ring-edge-brand">
              <PriceLockup
                priceMinor={service.priceMinor}
                currencyCode={service.currencyCode}
                currencyMinorUnit={service.currencyMinorUnit}
                labels={labels}
                size="detail"
              />

              {actions === undefined ? null : <div className="mt-6 flex flex-col gap-3">{actions}</div>}
              {pricing === null ? null : (
                <p className="mt-2">
                  <Badge tone="neutral">{pricing}</Badge>
                </p>
              )}
              {terms.length === 0 ? null : (
                <dl className="mt-5 space-y-3 border-t border-hairline pt-5">
                  {terms.map((term) => (
                    <div key={term.label} className="flex items-baseline justify-between gap-4">
                      <dt className="text-sm text-ink-muted">{term.label}</dt>
                      <dd className="text-sm font-medium text-ink-strong">{term.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <dl className="mt-5 space-y-4 border-t border-hairline pt-5">
                <div>
                  <dt className={TYPE.label}>{labels.sellerHeading}</dt>
                  <dd className="mt-0.5 text-sm text-ink-body" dir="auto">
                    {service.seller.displayName}
                  </dd>
                </div>
                <div>
                  <dt className={TYPE.label}>{labels.categoryHeading}</dt>
                  <dd className="mt-0.5 text-sm text-ink-body" dir="auto">
                    {service.category.name}
                  </dd>
                </div>
              </dl>
            </Card>

            {service.tags.length > 0 ? (
              <Card padding="lg">
                <h2 className={TYPE.label}>{labels.tagsHeading}</h2>
                <ul className="mt-3 flex list-none flex-wrap gap-2">
                  {service.tags.map((tag) => (
                    <li key={tag.slug}>
                      <Badge tone="neutral">{tag.name}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        }
      />
    </article>
  );
}
