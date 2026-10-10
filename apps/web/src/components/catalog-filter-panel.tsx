import type { CatalogFacet, CatalogFilters } from '@repo/contracts';
import { CATALOG_FILTER_PARAMS, catalogFiltersToParams } from '@repo/contracts';
import { Button, ButtonLink, Choice, ChoiceGroup, Input, Select, TYPE, cx } from '@repo/ui';

/**
 * The filter panel, as a plain HTML form (Phase 8-D).
 *
 * **It is a `GET` form and nothing else.** No JavaScript, no client component, no state: ticking a box and
 * pressing the button navigates, because that is what a form does. The consequence is the one the brief
 * asked for — a filtered view has a real URL that can be shared, bookmarked and reloaded, the back button
 * does the obvious thing, and the page works for a visitor whose JavaScript never arrives.
 *
 * **The control a dimension gets is the one its own kind calls for.** A select attribute gets checkboxes, so
 * two ticks are the alternatives the database treats them as; a boolean gets a yes and a no that can both be
 * left alone; a number gets two boxes, because a span is what the facet carries and buckets would be a rule
 * nobody has written. A count sits beside every value, including a zero — a value that disappeared when it
 * stopped matching would take a visitor's own choice away with it.
 *
 * **Every link is built from the same contract the parser reads**, so a panel cannot name a parameter the
 * API would refuse.
 *
 * **Nothing here decides what is offered.** The facets are the API's answer, which is the database's answer;
 * this component renders them and never invents a dimension, a bound or an ordering.
 *
 * **There is no sort control, and that is a decision rather than a gap** (0109). `catalog-filters.ts` states it
 * outright: "There is no sort parameter, because ordering is 0051's approved newest-first". A dropdown offering
 * "price, low to high" would therefore be a control that cannot work — so the ordering is *stated* instead, in
 * {@link CatalogToolbar}, where a person can see what they are looking at. Offering a sort would need an ordering
 * parameter on the catalogue readers and an owner decision reopening 0051.
 *
 * **0109 made the panel a disclosure on a narrow viewport.** A phone showed thirty filter rows above the first
 * result, which meant a person had to scroll past the whole panel to reach the catalogue. `<details>` collapses
 * it with no JavaScript and no state, and it stays open on a wide viewport where there is room for both.
 */

export interface CatalogFilterLabels {
  readonly heading: string;
  readonly apply: string;
  readonly clear: string;
  readonly tagsHeading: string;
  readonly listingTypeHeading: string;
  readonly priceHeading: string;
  readonly priceFrom: string;
  readonly priceTo: string;
  readonly priceCurrency: string;
  readonly from: string;
  readonly to: string;
  readonly typeProduct: string;
  readonly typeService: string;
  readonly yes: string;
  readonly no: string;
  readonly matches: (count: number) => string;
}

/** The spacing between one dimension and the next. The rest of the grammar comes from the primitives. */
const GROUP = 'mt-5';

/** Whether a value is currently chosen, read from the filters the page was rendered with. */
function chosen(filters: CatalogFilters, facet: CatalogFacet, value: string): boolean {
  if (facet.kind === 'tag') return (filters.tags ?? []).includes(value);
  if (facet.kind === 'listing_type') return filters.listingType === value;
  if (facet.kind === 'currency') return filters.price?.currency === value;
  if (facet.key === null) return false;

  const attribute = (filters.attributes ?? []).find((candidate) => candidate.key === facet.key);
  if (attribute === undefined) return false;
  if (facet.dataType === 'boolean') return attribute.boolean === (value === 'true');
  return (attribute.options ?? []).includes(value);
}

function attributeOf(filters: CatalogFilters, key: string): CatalogFilters['attributes'] extends undefined
  ? undefined
  : NonNullable<CatalogFilters['attributes']>[number] | undefined {
  return (filters.attributes ?? []).find((candidate) => candidate.key === key);
}

export function CatalogFilterPanel({
  action,
  facets,
  filters,
  labels,
  hidden = [],
}: {
  /** Where the form submits: the page's own address, so filtering is a navigation to itself. */
  readonly action: string;
  readonly facets: readonly CatalogFacet[];
  readonly filters: CatalogFilters;
  readonly labels: CatalogFilterLabels;
  /**
   * Parameters the page needs to keep across a filter change — a search's own `q`, for instance. The cursor
   * is deliberately **not** among them: changing a filter starts the list again rather than resuming
   * somebody else's page of a different question.
   */
  readonly hidden?: readonly { readonly name: string; readonly value: string }[];
}) {
  if (facets.length === 0) return null;

  const attributeFacets = facets.filter((facet) => facet.kind === 'attribute');
  const tagFacet = facets.find((facet) => facet.kind === 'tag');
  const typeFacet = facets.find((facet) => facet.kind === 'listing_type');
  const currencyFacets = facets.filter((facet) => facet.kind === 'currency');
  const anyFilter = catalogFiltersToParams(filters).length > 0;

  // Clearing keeps whatever the page needs and drops every filter, which is exactly the hidden fields.
  const cleared = new URLSearchParams(hidden.map((field) => [field.name, field.value]));
  const clearedQuery = cleared.toString();

  const activeCount = catalogFiltersToParams(filters).length;

  return (
    <form method="get" action={action} className="rounded-lg border border-hairline bg-surface-raised">
      {/*
        `<details>` with `open` from `lg` up: collapsed on a phone, where thirty rows above the first result made
        the catalogue unreachable, and always open on a desktop, where the panel is a column beside the grid.
        `[&_summary]:lg:hidden` hides the toggle rather than the content, so the group is never closed where the
        toggle is not there to reopen it.
      */}
      <details className="group lg:open:block" open>
        <summary
          className={cx(
            'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-5 py-4 lg:hidden',
            'marker:content-none [&::-webkit-details-marker]:hidden',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
          )}
        >
          <span className={TYPE.h4}>{labels.heading}</span>
          <span className="flex items-center gap-2">
            {activeCount === 0 ? null : (
              <span className="rounded-full bg-surface-ink px-2 py-0.5 text-xs font-medium text-on-ink tabular-nums">
                {activeCount}
              </span>
            )}
            <span
              aria-hidden="true"
              className="-mt-1 size-2 rotate-45 border-e-2 border-b-2 border-edge transition-transform duration-150 group-open:mt-1 group-open:-rotate-135"
            />
          </span>
        </summary>

        <div className="px-5 pt-1 pb-5 lg:pt-5">
          <h2 className={cx(TYPE.h4, 'hidden lg:block')}>{labels.heading}</h2>

          {hidden.map((field) => (
            <input key={field.name} type="hidden" name={field.name} value={field.value} />
          ))}

          {typeFacet === undefined || typeFacet.values.length < 2 ? null : (
            <ChoiceGroup legend={labels.listingTypeHeading} className={GROUP}>
              {typeFacet.values.map((value) => (
                <Choice
                  key={value.value}
                  type="radio"
                  name={CATALOG_FILTER_PARAMS.listingType}
                  value={value.value}
                  defaultChecked={chosen(filters, typeFacet, value.value)}
                  detail={labels.matches(value.matchCount)}
                >
                  {value.value === 'service' ? labels.typeService : labels.typeProduct}
                </Choice>
              ))}
            </ChoiceGroup>
          )}

      {attributeFacets.map((facet) => {
        const name = `${CATALOG_FILTER_PARAMS.attributePrefix}${facet.key ?? ''}`;
        const current = facet.key === null ? undefined : attributeOf(filters, facet.key);

        if (facet.dataType === 'number') {
          return (
            <ChoiceGroup
              key={facet.key}
              className={GROUP}
              legend={
                <>
                  {facet.label}
                  {facet.unit === null ? null : <span className="font-normal text-ink-muted"> ({facet.unit})</span>}
                </>
              }
            >
              {/* Two boxes, because a span is what the facet carries; buckets would be a rule nobody wrote. */}
              <div className="mt-1 flex gap-3">
                <label className="flex-1">
                  <span className="mb-1 block text-xs text-ink-muted">{labels.from}</span>
                  <Input
                    id={`${name}-min`}
                    name={`${name}.min`}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    defaultValue={String(current?.min ?? '')}
                    placeholder={facet.rangeMin ?? ''}
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-xs text-ink-muted">{labels.to}</span>
                  <Input
                    id={`${name}-max`}
                    name={`${name}.max`}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    defaultValue={String(current?.max ?? '')}
                    placeholder={facet.rangeMax ?? ''}
                  />
                </label>
              </div>
            </ChoiceGroup>
          );
        }

        if (facet.dataType === 'boolean') {
          return (
            <ChoiceGroup key={facet.key} legend={facet.label} className={GROUP}>
              {facet.values.map((value) => (
                <Choice
                  key={value.value}
                  type="radio"
                  name={name}
                  value={value.value}
                  defaultChecked={chosen(filters, facet, value.value)}
                  detail={labels.matches(value.matchCount)}
                >
                  {value.value === 'true' ? labels.yes : labels.no}
                </Choice>
              ))}
            </ChoiceGroup>
          );
        }

        return (
          <ChoiceGroup key={facet.key} legend={facet.label} className={GROUP}>
            {facet.values.map((value) => (
              <Choice
                key={value.value}
                type="checkbox"
                name={name}
                value={value.value}
                defaultChecked={chosen(filters, facet, value.value)}
                detail={labels.matches(value.matchCount)}
              >
                {value.label}
              </Choice>
            ))}
          </ChoiceGroup>
        );
      })}

          {tagFacet === undefined || tagFacet.values.length === 0 ? null : (
            <ChoiceGroup legend={labels.tagsHeading} className={GROUP}>
              {tagFacet.values.map((value) => (
                <Choice
                  key={value.value}
                  type="checkbox"
                  name={CATALOG_FILTER_PARAMS.tag}
                  value={value.value}
                  defaultChecked={chosen(filters, tagFacet, value.value)}
                  detail={labels.matches(value.matchCount)}
                >
                  {value.label}
                </Choice>
              ))}
            </ChoiceGroup>
          )}

          {currencyFacets.length === 0 ? null : (
            <ChoiceGroup legend={labels.priceHeading} className={GROUP}>
          {/* The currency is required with a bound, because there is no conversion: a price is only ever
              compared inside the currency it was listed in. The codes are the catalogue's own. */}
          {currencyFacets.length === 1 ? (
            <input
              type="hidden"
              name={CATALOG_FILTER_PARAMS.priceCurrency}
              value={currencyFacets[0]?.values[0]?.value ?? ''}
            />
          ) : (
                <label className="mt-1 block">
                  <span className="mb-1 block text-xs text-ink-muted">{labels.priceCurrency}</span>
                  <Select
                    id="price-currency"
                    name={CATALOG_FILTER_PARAMS.priceCurrency}
                    defaultValue={filters.price?.currency ?? ''}
                    options={currencyFacets.map((facet) => {
                      const code = facet.values[0]?.value ?? '';
                      return { value: code, label: code };
                    })}
                  />
                </label>
              )}
              <div className="mt-2 flex gap-3">
                <label className="flex-1">
                  <span className="mb-1 block text-xs text-ink-muted">{labels.priceFrom}</span>
                  <Input
                    id="price-min"
                    name={CATALOG_FILTER_PARAMS.priceMin}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    defaultValue={String(filters.price?.min ?? '')}
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-xs text-ink-muted">{labels.priceTo}</span>
                  <Input
                    id="price-max"
                    name={CATALOG_FILTER_PARAMS.priceMax}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    defaultValue={String(filters.price?.max ?? '')}
                  />
                </label>
              </div>
            </ChoiceGroup>
          )}

          <div className="mt-6 flex items-center gap-2 border-t border-hairline pt-5">
            <Button type="submit" size="md">
              {labels.apply}
            </Button>
            {anyFilter ? (
              <ButtonLink
                href={clearedQuery === '' ? action : `${action}?${clearedQuery}`}
                variant="ghost"
                size="md"
              >
                {labels.clear}
              </ButtonLink>
            ) : null}
          </div>
        </div>
      </details>
    </form>
  );
}

export interface CatalogToolbarLabels {
  readonly ordering: string;
  readonly resultCount: (count: number) => string;
}

/**
 * What a person is looking at, above the grid.
 *
 * **This is where the sort control is not.** `catalog-filters.ts` states that there is no sort parameter because
 * ordering is 0051's approved newest-first, so a dropdown here would be a control with nothing to send. Stating
 * the ordering instead gives a person the same information the control was supposed to convey — what order these
 * results are in — without implying a choice the product does not offer.
 *
 * The count is announced politely: changing a filter is a navigation, and somebody who is not watching the screen
 * needs to hear how many results came back.
 */
export function CatalogToolbar({
  count,
  labels,
  className,
}: {
  readonly count: number;
  readonly labels: CatalogToolbarLabels;
  readonly className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline pb-3',
        className,
      )}
    >
      <p className="text-sm font-medium text-ink-strong tabular-nums" aria-live="polite">
        {labels.resultCount(count)}
      </p>
      <p className="text-sm text-ink-muted">{labels.ordering}</p>
    </div>
  );
}
