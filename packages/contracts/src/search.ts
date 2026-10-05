import { ListingSummarySchema } from './listings.js';
import { ServiceSummarySchema } from './services.js';
import { z } from './zod.js';

/**
 * Public search (Phase 4-F, V1).
 *
 * Results are **mixed**: one query returns products and services together, because both live in one
 * table and a person searching the marketplace is not thinking about which surface owns what. The two
 * keep their own card contracts rather than being flattened into a lowest common denominator — a service
 * result still carries its pricing model, delivery time and revisions, a listing result still carries its
 * negotiability — so `type` discriminates between them and the client renders each with the component
 * that already exists for it.
 *
 * V1 has no filters, no distance and no relevance ranking. Ordering is newest-first and provisional; the
 * approved ranking formula and promoted-result merging are a Phase 9 decision.
 */

/** Which surface a result belongs to. Exactly two, matching the two public card contracts. */
export const SEARCH_RESULT_TYPES = ['listing', 'service'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

/** Page size: the approved default and ceiling, mirroring the browse surfaces. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** The shortest query the API will run, counted in Unicode characters rather than UTF-16 units. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

export const SearchListingResultSchema = ListingSummarySchema.extend({
  type: z.literal('listing'),
})
  .strict()
  .openapi('SearchListingResult');

export const SearchServiceResultSchema = ServiceSummarySchema.extend({
  type: z.literal('service'),
})
  .strict()
  .openapi('SearchServiceResult');

export const SearchResultSchema = z
  .discriminatedUnion('type', [SearchListingResultSchema, SearchServiceResultSchema])
  .openapi('SearchResult');

export const SearchResponseSchema = z
  .object({
    items: z.array(SearchResultSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SearchResponse');

export type SearchListingResult = z.infer<typeof SearchListingResultSchema>;
export type SearchServiceResult = z.infer<typeof SearchServiceResultSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Parses the `q` query parameter.
 *
 * Whitespace is trimmed first, then the length is counted in **Unicode characters** — `Array.from`
 * rather than `.length`, because `.length` counts UTF-16 code units and would let a two-character query
 * made of surrogate pairs through while rejecting nothing it should. An empty or one-character query is
 * a 400 and never a silent browse feed: a search that quietly becomes "everything" is a worse answer
 * than an honest refusal.
 */
export function parseSearchQuery(value: unknown): { ok: true; query: string } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  const query = value.trim();
  return Array.from(query).length >= SEARCH_MIN_QUERY_LENGTH ? { ok: true, query } : { ok: false };
}

/**
 * Parses the `limit` query parameter.
 *
 * Absent means the default. Anything that is not a whole number in range is invalid rather than silently
 * clamped, exactly as on the browse surfaces.
 */
export function parseSearchLimit(value: unknown): { ok: true; limit: number } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, limit: SEARCH_DEFAULT_LIMIT };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return { ok: false };
  const limit = Number(value);
  return limit <= SEARCH_MAX_LIMIT ? { ok: true, limit } : { ok: false };
}
