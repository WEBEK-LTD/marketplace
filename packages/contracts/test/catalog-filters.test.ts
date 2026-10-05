import { describe, expect, it } from 'vitest';
import {
  CatalogFiltersSchema,
  catalogFiltersAreEmpty,
  catalogFiltersToParams,
  parseCatalogFilters,
} from '../src/catalog-filters.js';

/**
 * The shared catalogue filters (8-D).
 *
 * What this suite is about:
 *
 * **Shape is refused here; vocabulary is not.** A malformed parameter fails to parse, which becomes a 400.
 * A well-formed value naming nothing real — an unknown tag, an attribute nobody defined — parses happily and
 * is the database's to answer with nothing, because dropping it here would answer a wider question than the
 * visitor asked. The two are different failures and the line between them is the point.
 *
 * **The encoding is what a plain HTML form submits**, so the panel works with no JavaScript: repeated
 * parameters for a dimension's alternatives, and a dotted suffix for a numeric range.
 *
 * **Parsing and link-building are inverses**, so a screen that writes a URL from the filters it parsed
 * cannot drift from the parser — asserted by round-tripping rather than by reading both implementations.
 */

const parsed = (params: Record<string, string | string[] | undefined>) => parseCatalogFilters(params);

describe('what parses', () => {
  it('reads nothing out of nothing', () => {
    const result = parsed({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters).toEqual({});
      expect(catalogFiltersAreEmpty(result.filters)).toBe(true);
    }
  });

  it('ignores the parameters that belong to the page rather than to the filters', () => {
    const result = parsed({ cursor: 'abc', locale: 'ar', limit: '20', utm_source: 'somewhere' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(catalogFiltersAreEmpty(result.filters)).toBe(true);
  });

  it('reads one listing type', () => {
    const result = parsed({ type: 'service' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.listingType).toBe('service');
  });

  it('reads repeated tags as the alternatives they are, without repeats', () => {
    const result = parsed({ tag: ['handmade', 'vintage', 'handmade'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.tags).toEqual(['handmade', 'vintage']);
  });

  it('reads a select attribute’s options', () => {
    const result = parsed({ 'attr.material': ['oak', 'pine'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.attributes).toEqual([{ key: 'material', options: ['oak', 'pine'] }]);
  });

  it('reads a boolean attribute as a boolean, not as a one-item list', () => {
    for (const [sent, expected] of [
      ['true', true],
      ['false', false],
    ] as const) {
      const result = parsed({ 'attr.boxed': sent });
      expect(result.ok, sent).toBe(true);
      if (result.ok) expect(result.filters.attributes).toEqual([{ key: 'boxed', boolean: expected }]);
    }
  });

  it('reads a numeric range from its two ends, either of which may be absent', () => {
    const both = parsed({ 'attr.width.min': '120', 'attr.width.max': '200' });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.filters.attributes).toEqual([{ key: 'width', min: 120, max: 200 }]);

    const lower = parsed({ 'attr.width.min': '120' });
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.filters.attributes).toEqual([{ key: 'width', min: 120 }]);

    const upper = parsed({ 'attr.width.max': '200.5' });
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.filters.attributes).toEqual([{ key: 'width', max: 200.5 }]);
  });

  it('reads several attributes at once, each its own dimension', () => {
    const result = parsed({
      'attr.material': 'oak',
      'attr.boxed': 'true',
      'attr.width.min': '100',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.attributes).toHaveLength(3);
      expect(result.filters.attributes?.map((attribute) => attribute.key).sort()).toEqual([
        'boxed',
        'material',
        'width',
      ]);
    }
  });

  it('reads a price bound as a string of minor units, with its currency', () => {
    const result = parsed({ 'price.currency': 'ABC', 'price.min': '1000', 'price.max': '500000' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.price).toEqual({ currency: 'ABC', min: '1000', max: '500000' });
    }
  });

  it('reads a currency with no bounds: a dimension chosen but not yet limited', () => {
    const result = parsed({ 'price.currency': 'ABC' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.price).toEqual({ currency: 'ABC' });
  });

  it('accepts a value that names nothing real, because that is the database’s answer to give', () => {
    const result = parsed({ tag: 'no-such-tag-anywhere', 'attr.nothing_defined': 'whatever' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.tags).toEqual(['no-such-tag-anywhere']);
      expect(result.filters.attributes).toEqual([{ key: 'nothing_defined', options: ['whatever'] }]);
    }
  });
});

describe('what does not parse', () => {
  it('refuses a listing type that is not one of the two', () => {
    expect(parsed({ type: 'vehicle' }).ok).toBe(false);
    expect(parsed({ type: 'Product' }).ok).toBe(false);
  });

  it('refuses a parameter that may appear once and was sent twice', () => {
    expect(parsed({ type: ['product', 'service'] }).ok).toBe(false);
    expect(parsed({ 'price.currency': ['ABC', 'XYZ'] }).ok).toBe(false);
    expect(parsed({ 'attr.width.min': ['1', '2'] }).ok).toBe(false);
  });

  it('refuses a tag slug the column would refuse', () => {
    for (const tag of ['Handmade', 'with space', '-leading', 'a'.repeat(51)]) {
      expect(parsed({ tag }).ok, tag).toBe(false);
    }
  });

  it('refuses an attribute key that is not key-shaped, and an empty one', () => {
    for (const name of ['attr.Material', 'attr.9lives', 'attr.', 'attr.a.b.c']) {
      expect(parsed({ [name]: 'oak' }).ok, name).toBe(false);
    }
  });

  it('refuses an option value the column would refuse', () => {
    expect(parsed({ 'attr.material': 'Oak' }).ok).toBe(false);
    expect(parsed({ 'attr.material': 'with space' }).ok).toBe(false);
  });

  it('refuses a range end that is not a number', () => {
    for (const bound of ['cheap', '', '1e5', '--1', '1,5']) {
      expect(parsed({ 'attr.width.min': bound }).ok, bound).toBe(bound === '' ? true : false);
    }
  });

  it('refuses an attribute given two kinds of value at once', () => {
    // Options and a range would be two different questions about one attribute.
    expect(parsed({ 'attr.width': 'oak', 'attr.width.min': '10' }).ok).toBe(false);
    expect(parsed({ 'attr.boxed': 'true', 'attr.boxed.max': '10' }).ok).toBe(false);
  });

  it('refuses a range that ends before it begins', () => {
    expect(parsed({ 'attr.width.min': '200', 'attr.width.max': '100' }).ok).toBe(false);
  });

  it('refuses a price bound with no currency, rather than ignoring the bound', () => {
    expect(parsed({ 'price.min': '1000' }).ok).toBe(false);
    expect(parsed({ 'price.max': '1000' }).ok).toBe(false);
  });

  it('refuses a price that is not whole minor units', () => {
    for (const bound of ['10.5', '-10', '1e5', 'free', '1'.repeat(19)]) {
      expect(parsed({ 'price.currency': 'ABC', 'price.min': bound }).ok, bound).toBe(false);
    }
  });

  it('refuses a currency code that is not code-shaped', () => {
    for (const currency of ['abc', 'ABCD', 'AB', '123']) {
      expect(parsed({ 'price.currency': currency }).ok, currency).toBe(false);
    }
  });

  it('refuses a price range that ends below where it begins', () => {
    expect(parsed({ 'price.currency': 'ABC', 'price.min': '500', 'price.max': '100' }).ok).toBe(false);
  });

  it('refuses more values in one dimension than a request may carry', () => {
    const tags = Array.from({ length: 26 }, (_, index) => `tag-${index}`);
    expect(parsed({ tag: tags }).ok).toBe(false);
  });

  it('refuses a document the schema does not recognise, however it was assembled', () => {
    expect(CatalogFiltersSchema.safeParse({ listingType: 'product', sortBy: 'price' }).success).toBe(false);
    expect(CatalogFiltersSchema.safeParse({ tags: [] }).success).toBe(false);
    expect(CatalogFiltersSchema.safeParse({ attributes: [{ key: 'width' }] }).success).toBe(false);
  });
});

describe('parsing and link-building are inverses', () => {
  const cases: Record<string, string | string[]>[] = [
    { type: 'product' },
    { tag: ['handmade', 'vintage'] },
    { 'attr.material': ['oak', 'pine'] },
    { 'attr.boxed': 'false' },
    { 'attr.width.min': '120', 'attr.width.max': '200' },
    { 'price.currency': 'ABC', 'price.min': '1000', 'price.max': '2000' },
    {
      type: 'service',
      tag: 'handmade',
      'attr.material': 'oak',
      'attr.width.min': '10',
      'price.currency': 'ABC',
      'price.max': '9000',
    },
  ];

  for (const [index, params] of cases.entries()) {
    it(`round-trips case ${index + 1}`, () => {
      const first = parsed(params);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // Rebuild the query string from the filters, then read it again.
      const rebuilt: Record<string, string | string[]> = {};
      for (const [name, value] of catalogFiltersToParams(first.filters)) {
        const existing = rebuilt[name];
        if (existing === undefined) rebuilt[name] = value;
        else rebuilt[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      }

      const second = parseCatalogFilters(rebuilt);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.filters).toEqual(first.filters);
    });
  }

  it('writes the same URL for the same filters, whatever order they arrived in', () => {
    const one = parsed({ tag: ['vintage', 'handmade'] });
    const other = parsed({ tag: ['handmade', 'vintage'] });
    expect(one.ok && other.ok).toBe(true);
    if (one.ok && other.ok) {
      expect(catalogFiltersToParams(one.filters)).toEqual(catalogFiltersToParams(other.filters));
    }
  });

  it('writes nothing for no filters, which is what makes a canonical comparison meaningful', () => {
    expect(catalogFiltersToParams({})).toEqual([]);
  });
});
