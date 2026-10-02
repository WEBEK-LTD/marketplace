import { z } from './zod.js';
import {
  ATTRIBUTE_DATA_TYPES,
  AttributeKeySchema,
  AttributeOptionValueSchema,
  TagSlugSchema,
} from './attributes-admin.js';
import { LISTING_ATTRIBUTE_NUMBER_ABS_MAX } from './seller-listing-attributes.js';
import { SearchResultSchema } from './search.js';

/**
 * One filter language, for the public category feed and for search.
 *
 * Two surfaces, one contract, because they are one question asked in two places: a visitor narrowing a
 * category and a visitor narrowing a search mean the same thing by "oak", and 0089 answers both with the
 * same two database functions. A second filter vocabulary would be a second chance for them to disagree.
 *
 * **Filters travel in the query string**, so a filtered view has a URL that can be shared, bookmarked and
 * reloaded, the back button does the obvious thing, and the panel works with no JavaScript at all — an HTML
 * checkbox named `tag` produces `?tag=handmade&tag=rare` without help. The encoding below is therefore the
 * shape plain form controls already submit, not a format a client has to build.
 *
 * **Shape is checked here; vocabulary is checked in the database.** A malformed parameter is a 400. A
 * well-formed value naming something that does not exist — an unknown tag, a hidden option, an attribute
 * nobody defined — is *not* a 400: it returns no results, because 0089 refuses to answer a narrower
 * question than the one asked by dropping the part it did not recognise. The two failures are different and
 * are answered differently.
 *
 * **Within one dimension values are alternatives; across dimensions they accumulate.** Two options of one
 * attribute match a listing carrying either; an option and a tag match only a listing carrying both. The
 * other reading would make a second tick always return less, and usually nothing.
 *
 * **Nothing here ranks.** There is no sort parameter, because ordering is 0051's approved newest-first and
 * the ranking formula is a Phase 9 decision.
 */

// ---------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------
/** `listing_types`: the two seeded surfaces. A category may hold either or both. */
export const CATALOG_LISTING_TYPES = ['product', 'service'] as const;
export type CatalogListingType = (typeof CATALOG_LISTING_TYPES)[number];
export const CatalogListingTypeSchema = z.enum(CATALOG_LISTING_TYPES);

/**
 * How many values one dimension may carry, and how many attributes one request may name.
 *
 * The contract's own bounds: a request is not allowed to be arbitrarily large, and nothing in the schema
 * limits how many tags exist. Generous enough that no real panel reaches them.
 */
export const CATALOG_FILTER_MAX_TAGS = 25;
export const CATALOG_FILTER_MAX_ATTRIBUTES = 25;
export const CATALOG_FILTER_MAX_OPTIONS = 50;

/**
 * A price bound is a whole number of minor units carried as a **string**, which is the money rule of Phase
 * 1 Step 2: `price_minor` is a `bigint`, and a JSON number cannot hold every one of those exactly. Up to 18
 * digits, which is comfortably inside `bigint` so no conversion can overflow.
 */
export const CATALOG_PRICE_MINOR_PATTERN = /^[0-9]{1,18}$/;

/** An ISO 4217 code's shape. The codes themselves are data: none is named in source anywhere. */
export const CATALOG_CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export const CatalogCurrencyCodeSchema = z.string().regex(CATALOG_CURRENCY_CODE_PATTERN);

// ---------------------------------------------------------------------------------------------------
// The filter document
// ---------------------------------------------------------------------------------------------------
/**
 * One attribute's filter, shaped by the kind of attribute it is.
 *
 * A discriminated union would be tidier, but the query string carries no discriminant: `attr.width.min=120`
 * says "a range" by its shape alone. So the three forms are optional fields with a refinement that exactly
 * one of them is present — which is also what the database checks against the attribute's real data type.
 */
export const CatalogAttributeFilterSchema = z
  .object({
    key: AttributeKeySchema,
    /** Any one of these matches: the alternatives within this dimension. */
    options: z.array(AttributeOptionValueSchema).min(1).max(CATALOG_FILTER_MAX_OPTIONS).optional(),
    boolean: z.boolean().optional(),
    min: z.number().finite().min(-LISTING_ATTRIBUTE_NUMBER_ABS_MAX).max(LISTING_ATTRIBUTE_NUMBER_ABS_MAX).optional(),
    max: z.number().finite().min(-LISTING_ATTRIBUTE_NUMBER_ABS_MAX).max(LISTING_ATTRIBUTE_NUMBER_ABS_MAX).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.options !== undefined ? 1 : 0) +
        (value.boolean !== undefined ? 1 : 0) +
        (value.min !== undefined || value.max !== undefined ? 1 : 0) ===
      1,
    { message: 'an attribute filter carries options, a boolean, or a range — exactly one' },
  )
  .refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, {
    message: 'a range cannot end before it begins',
    path: ['max'],
  });
export type CatalogAttributeFilter = z.infer<typeof CatalogAttributeFilterSchema>;

/**
 * A price bound, and the currency it is read in.
 *
 * The currency is **required** with a bound and there is no conversion anywhere: V1 has no FX and no
 * `fx_rates` table, so comparing one currency's number against another's would be inventing a rate. A
 * bound therefore narrows to the listings priced in that currency, and a listing with no price — a
 * custom-priced service — matches no bound rather than being assumed cheap.
 */
export const CatalogPriceFilterSchema = z
  .object({
    currency: CatalogCurrencyCodeSchema,
    min: z.string().regex(CATALOG_PRICE_MINOR_PATTERN).optional(),
    max: z.string().regex(CATALOG_PRICE_MINOR_PATTERN).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.min === undefined || value.max === undefined || BigInt(value.min) <= BigInt(value.max),
    { message: 'a price range cannot end below where it begins', path: ['max'] },
  );
export type CatalogPriceFilter = z.infer<typeof CatalogPriceFilterSchema>;

/** The whole document, exactly as it reaches the database. Every part is optional. */
export const CatalogFiltersSchema = z
  .object({
    listingType: CatalogListingTypeSchema.optional(),
    tags: z.array(TagSlugSchema).min(1).max(CATALOG_FILTER_MAX_TAGS).optional(),
    attributes: z.array(CatalogAttributeFilterSchema).min(1).max(CATALOG_FILTER_MAX_ATTRIBUTES).optional(),
    price: CatalogPriceFilterSchema.optional(),
  })
  .strict();
export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>;

/** Whether a document narrows anything at all, which is what decides a canonical and a `noindex`. */
export function catalogFiltersAreEmpty(filters: CatalogFilters): boolean {
  return (
    filters.listingType === undefined &&
    filters.tags === undefined &&
    filters.attributes === undefined &&
    filters.price === undefined
  );
}

// ---------------------------------------------------------------------------------------------------
// The query string
// ---------------------------------------------------------------------------------------------------
/**
 * The parameter names, in one place so the parser and the link builder cannot drift.
 *
 * `attr.<key>` carries a select attribute's chosen options, repeated once per option, or a boolean's
 * `true`/`false`. `attr.<key>.min` and `.max` carry a numeric range. The prefix keeps an attribute whose key
 * happens to be `tag` from colliding with the tag parameter.
 */
export const CATALOG_FILTER_PARAMS = {
  listingType: 'type',
  tag: 'tag',
  attributePrefix: 'attr.',
  priceCurrency: 'price.currency',
  priceMin: 'price.min',
  priceMax: 'price.max',
} as const;

/** Every value a repeated parameter carried, in the order the browser sent them. */
function values(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => (value === '' ? [] : [value]));
}

function single(raw: string | readonly string[] | undefined): string | undefined {
  const all = values(raw);
  // A parameter that may appear once, sent twice, is a malformed request rather than a choice to make for
  // the caller. The caller is told rather than guessed at.
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : undefined;
}

function sentTwice(raw: string | readonly string[] | undefined): boolean {
  return values(raw).length > 1;
}

/**
 * Reads a filter document out of query parameters.
 *
 * Returns `{ ok: false }` for a request whose *shape* is wrong — a type that is not one of the two, a
 * malformed slug, a range that is not a number, a price bound without a currency, an attribute given two
 * kinds of value at once. A well-formed value that names nothing real is **not** a failure here: it travels
 * to the database and returns nothing, which is the only reading under which a filter cannot widen.
 *
 * Unknown parameters are ignored rather than refused, because a page's own parameters — `cursor`, `locale`
 * and whatever a campaign appends — share this query string.
 */
export function parseCatalogFilters(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): { ok: true; filters: CatalogFilters } | { ok: false } {
  const draft: Record<string, unknown> = {};

  // The listing type.
  if (sentTwice(params[CATALOG_FILTER_PARAMS.listingType])) return { ok: false };
  const type = single(params[CATALOG_FILTER_PARAMS.listingType]);
  if (type !== undefined) {
    if (!(CATALOG_LISTING_TYPES as readonly string[]).includes(type)) return { ok: false };
    draft.listingType = type;
  }

  // The tags, in the order they arrived, without repeats.
  const tags = [...new Set(values(params[CATALOG_FILTER_PARAMS.tag]))];
  if (tags.length > 0) draft.tags = tags;

  // The attributes. One entry per key, assembled from however many parameters mentioned it.
  const byKey = new Map<string, { options: string[]; boolean?: string; min?: string; max?: string }>();
  const entryFor = (key: string): { options: string[]; boolean?: string; min?: string; max?: string } => {
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const created = { options: [] as string[] };
    byKey.set(key, created);
    return created;
  };

  for (const [name, raw] of Object.entries(params)) {
    if (!name.startsWith(CATALOG_FILTER_PARAMS.attributePrefix)) continue;
    const rest = name.slice(CATALOG_FILTER_PARAMS.attributePrefix.length);
    if (rest === '') return { ok: false };

    if (rest.endsWith('.min') || rest.endsWith('.max')) {
      const key = rest.slice(0, -4);
      if (key === '') return { ok: false };
      if (sentTwice(raw)) return { ok: false };
      const bound = single(raw);
      if (bound === undefined) continue;
      const entry = entryFor(key);
      if (rest.endsWith('.min')) entry.min = bound;
      else entry.max = bound;
      continue;
    }

    // A dot anywhere else is a parameter this contract does not define, and a key cannot contain one.
    if (rest.includes('.')) return { ok: false };
    const given = values(raw);
    if (given.length === 0) continue;
    const entry = entryFor(rest);
    // `true` and `false` are not option values — the pattern forbids them — so a boolean is unambiguous.
    if (given.length === 1 && (given[0] === 'true' || given[0] === 'false')) entry.boolean = given[0];
    else entry.options = [...new Set(given)];
  }

  const attributes: unknown[] = [];
  for (const [key, entry] of byKey) {
    const parts: Record<string, unknown> = { key };
    if (entry.options.length > 0) parts.options = entry.options;
    if (entry.boolean !== undefined) parts.boolean = entry.boolean === 'true';
    for (const bound of ['min', 'max'] as const) {
      const value = entry[bound];
      if (value === undefined) continue;
      // A range end must be a number. `Number('')` is 0 and `Number('x')` is NaN, so both are checked.
      if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) return { ok: false };
      parts[bound] = Number(value);
    }
    attributes.push(parts);
  }
  if (attributes.length > 0) draft.attributes = attributes;

  // The price. A bound without a currency is refused rather than ignored: ignoring it would answer a
  // wider question than the visitor asked.
  const currency = single(params[CATALOG_FILTER_PARAMS.priceCurrency]);
  const priceMin = single(params[CATALOG_FILTER_PARAMS.priceMin]);
  const priceMax = single(params[CATALOG_FILTER_PARAMS.priceMax]);
  if (
    sentTwice(params[CATALOG_FILTER_PARAMS.priceCurrency]) ||
    sentTwice(params[CATALOG_FILTER_PARAMS.priceMin]) ||
    sentTwice(params[CATALOG_FILTER_PARAMS.priceMax])
  ) {
    return { ok: false };
  }
  if (priceMin !== undefined || priceMax !== undefined) {
    if (currency === undefined) return { ok: false };
  }
  if (currency !== undefined) {
    const price: Record<string, unknown> = { currency };
    if (priceMin !== undefined) price.min = priceMin;
    if (priceMax !== undefined) price.max = priceMax;
    draft.price = price;
  }

  const parsed = CatalogFiltersSchema.safeParse(draft);
  return parsed.success ? { ok: true, filters: parsed.data } : { ok: false };
}

/**
 * Writes a filter document back out as query parameters, so a screen builds its own links from the same
 * definition it parsed them with. Sorted, so the same filters always produce the same URL — which is what
 * makes a filtered URL cacheable and a canonical comparison meaningful.
 */
export function catalogFiltersToParams(filters: CatalogFilters): [string, string][] {
  const out: [string, string][] = [];
  if (filters.listingType !== undefined) out.push([CATALOG_FILTER_PARAMS.listingType, filters.listingType]);
  for (const tag of [...(filters.tags ?? [])].sort()) out.push([CATALOG_FILTER_PARAMS.tag, tag]);

  for (const attribute of [...(filters.attributes ?? [])].sort((a, b) => a.key.localeCompare(b.key))) {
    const name = `${CATALOG_FILTER_PARAMS.attributePrefix}${attribute.key}`;
    for (const option of [...(attribute.options ?? [])].sort()) out.push([name, option]);
    if (attribute.boolean !== undefined) out.push([name, attribute.boolean ? 'true' : 'false']);
    if (attribute.min !== undefined) out.push([`${name}.min`, String(attribute.min)]);
    if (attribute.max !== undefined) out.push([`${name}.max`, String(attribute.max)]);
  }

  if (filters.price !== undefined) {
    out.push([CATALOG_FILTER_PARAMS.priceCurrency, filters.price.currency]);
    if (filters.price.min !== undefined) out.push([CATALOG_FILTER_PARAMS.priceMin, filters.price.min]);
    if (filters.price.max !== undefined) out.push([CATALOG_FILTER_PARAMS.priceMax, filters.price.max]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// What a category offers, and what it returns
// ---------------------------------------------------------------------------------------------------
/** The kinds of facet a category offers. One shape for all of them, so a screen groups rather than branches. */
export const CATALOG_FACET_KINDS = ['attribute', 'tag', 'listing_type', 'currency'] as const;
export type CatalogFacetKind = (typeof CATALOG_FACET_KINDS)[number];

/**
 * One value a visitor may filter by, and how many listings it would leave.
 *
 * **The count is computed under the filters already active**, so it answers "what happens if I tick this
 * too". A count of zero is an honest answer and not a reason to hide the row: the value stays offered so a
 * visitor can always untick what they ticked. The counts of one dimension are not expected to sum to the
 * result total — one listing can carry two tags.
 */
export const CatalogFacetValueSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    matchCount: z.number().int().min(0),
  })
  .strict()
  .openapi('CatalogFacetValue');
export type CatalogFacetValue = z.infer<typeof CatalogFacetValueSchema>;

/**
 * One dimension of the filter panel.
 *
 * An attribute dimension carries its key, its label and its data type, so a screen renders the control the
 * attribute's own kind calls for rather than guessing from the values. A number dimension carries the range
 * its matching listings span and no values: bounds let a screen draw two boxes, and buckets would be a rule
 * nobody has written. A currency dimension carries `minorUnit` so a price box knows where the decimal goes.
 */
export const CatalogFacetSchema = z
  .object({
    kind: z.enum(CATALOG_FACET_KINDS),
    /** Present only on an attribute dimension. */
    key: AttributeKeySchema.nullable(),
    label: z.string().nullable(),
    dataType: z.enum(ATTRIBUTE_DATA_TYPES).nullable(),
    unit: z.string().nullable(),
    values: z.array(CatalogFacetValueSchema),
    /** Present on a number attribute and on a currency: the span of the matching listings. */
    rangeMin: z.string().nullable(),
    rangeMax: z.string().nullable(),
    /** The currency's decimal places, present on a currency dimension alone. */
    minorUnit: z.number().int().min(0).max(4).nullable(),
  })
  .strict()
  .openapi('CatalogFacet');
export type CatalogFacet = z.infer<typeof CatalogFacetSchema>;

/**
 * One page of a category's listings, with the panel that produced it.
 *
 * `total` is deliberately absent: a count over the whole filtered set is a second query on every page, and
 * the facet counts already say how many each choice would leave.
 */
export const CategoryFeedResponseSchema = z
  .object({
    items: z.array(SearchResultSchema),
    nextCursor: z.string().nullable(),
    facets: z.array(CatalogFacetSchema),
  })
  .strict()
  .openapi('CategoryFeedResponse');
export type CategoryFeedResponse = z.infer<typeof CategoryFeedResponseSchema>;
