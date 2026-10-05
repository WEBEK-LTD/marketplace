import type { CatalogFacet, CatalogFilters } from '@repo/contracts';
import { CATALOG_FILTER_PARAMS, catalogFiltersToParams } from '@repo/contracts';

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

const FIELDSET = 'mt-5 border-t border-neutral-200 pt-4';
const LEGEND = 'text-sm font-semibold text-neutral-900';
const ROW = 'mt-2 flex items-center gap-2';
const COUNT = 'text-xs text-neutral-600';
const BOX = 'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const BUTTON = 'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-0';
const LINK =
  'text-sm underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900';

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

  return (
    <form method="get" action={action} className="mt-8 rounded-lg border border-neutral-200 p-5">
      <h2 className="text-lg font-semibold text-neutral-900">{labels.heading}</h2>

      {hidden.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}

      {typeFacet === undefined || typeFacet.values.length < 2 ? null : (
        <fieldset className={FIELDSET}>
          <legend className={LEGEND}>{labels.listingTypeHeading}</legend>
          {typeFacet.values.map((value) => (
            <label key={value.value} className={ROW}>
              <input
                type="radio"
                name={CATALOG_FILTER_PARAMS.listingType}
                value={value.value}
                defaultChecked={chosen(filters, typeFacet, value.value)}
              />
              <span className="text-sm text-neutral-900">
                {value.value === 'service' ? labels.typeService : labels.typeProduct}
              </span>
              <span className={COUNT}>{labels.matches(value.matchCount)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {attributeFacets.map((facet) => {
        const name = `${CATALOG_FILTER_PARAMS.attributePrefix}${facet.key ?? ''}`;
        const current = facet.key === null ? undefined : attributeOf(filters, facet.key);

        if (facet.dataType === 'number') {
          return (
            <fieldset key={facet.key} className={FIELDSET}>
              <legend className={LEGEND}>
                {facet.label}
                {facet.unit === null ? null : <span className="text-neutral-600"> ({facet.unit})</span>}
              </legend>
              <div className="mt-2 flex gap-3">
                <label className="flex-1">
                  <span className="block text-xs text-neutral-600">{labels.from}</span>
                  <input
                    className={BOX}
                    type="number"
                    step="any"
                    name={`${name}.min`}
                    defaultValue={current?.min ?? ''}
                    placeholder={facet.rangeMin ?? ''}
                  />
                </label>
                <label className="flex-1">
                  <span className="block text-xs text-neutral-600">{labels.to}</span>
                  <input
                    className={BOX}
                    type="number"
                    step="any"
                    name={`${name}.max`}
                    defaultValue={current?.max ?? ''}
                    placeholder={facet.rangeMax ?? ''}
                  />
                </label>
              </div>
            </fieldset>
          );
        }

        if (facet.dataType === 'boolean') {
          return (
            <fieldset key={facet.key} className={FIELDSET}>
              <legend className={LEGEND}>{facet.label}</legend>
              {facet.values.map((value) => (
                <label key={value.value} className={ROW}>
                  <input
                    type="radio"
                    name={name}
                    value={value.value}
                    defaultChecked={chosen(filters, facet, value.value)}
                  />
                  <span className="text-sm text-neutral-900">
                    {value.value === 'true' ? labels.yes : labels.no}
                  </span>
                  <span className={COUNT}>{labels.matches(value.matchCount)}</span>
                </label>
              ))}
            </fieldset>
          );
        }

        return (
          <fieldset key={facet.key} className={FIELDSET}>
            <legend className={LEGEND}>{facet.label}</legend>
            {facet.values.map((value) => (
              <label key={value.value} className={ROW}>
                <input
                  type="checkbox"
                  name={name}
                  value={value.value}
                  defaultChecked={chosen(filters, facet, value.value)}
                />
                <span className="text-sm text-neutral-900">{value.label}</span>
                <span className={COUNT}>{labels.matches(value.matchCount)}</span>
              </label>
            ))}
          </fieldset>
        );
      })}

      {tagFacet === undefined || tagFacet.values.length === 0 ? null : (
        <fieldset className={FIELDSET}>
          <legend className={LEGEND}>{labels.tagsHeading}</legend>
          {tagFacet.values.map((value) => (
            <label key={value.value} className={ROW}>
              <input
                type="checkbox"
                name={CATALOG_FILTER_PARAMS.tag}
                value={value.value}
                defaultChecked={chosen(filters, tagFacet, value.value)}
              />
              <span className="text-sm text-neutral-900">{value.label}</span>
              <span className={COUNT}>{labels.matches(value.matchCount)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {currencyFacets.length === 0 ? null : (
        <fieldset className={FIELDSET}>
          <legend className={LEGEND}>{labels.priceHeading}</legend>
          {/* The currency is required with a bound, because there is no conversion: a price is only ever
              compared inside the currency it was listed in. The codes are the catalogue's own. */}
          {currencyFacets.length === 1 ? (
            <input
              type="hidden"
              name={CATALOG_FILTER_PARAMS.priceCurrency}
              value={currencyFacets[0]?.values[0]?.value ?? ''}
            />
          ) : (
            <label className="mt-2 block">
              <span className="block text-xs text-neutral-600">{labels.priceCurrency}</span>
              <select
                className={BOX}
                name={CATALOG_FILTER_PARAMS.priceCurrency}
                defaultValue={filters.price?.currency ?? ''}
              >
                {currencyFacets.map((facet) => {
                  const code = facet.values[0]?.value ?? '';
                  return (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <div className="mt-2 flex gap-3">
            <label className="flex-1">
              <span className="block text-xs text-neutral-600">{labels.priceFrom}</span>
              <input
                className={BOX}
                type="number"
                min={0}
                step={1}
                name={CATALOG_FILTER_PARAMS.priceMin}
                defaultValue={filters.price?.min ?? ''}
              />
            </label>
            <label className="flex-1">
              <span className="block text-xs text-neutral-600">{labels.priceTo}</span>
              <input
                className={BOX}
                type="number"
                min={0}
                step={1}
                name={CATALOG_FILTER_PARAMS.priceMax}
                defaultValue={filters.price?.max ?? ''}
              />
            </label>
          </div>
        </fieldset>
      )}

      <div className="mt-6 flex items-center gap-4">
        <button className={BUTTON} type="submit">
          {labels.apply}
        </button>
        {anyFilter ? (
          <a className={LINK} href={clearedQuery === '' ? action : `${action}?${clearedQuery}`}>
            {labels.clear}
          </a>
        ) : null}
      </div>
    </form>
  );
}
