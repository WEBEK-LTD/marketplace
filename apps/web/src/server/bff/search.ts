import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SearchResponseSchema,
  catalogFiltersToParams,
  parseCatalogFilters,
  publicLocaleOf,
  type CatalogFilters,
  type SearchResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of public search (Phase 4-F, V1).
 *
 * The browser asks this origin; this module makes the one credentialled internal hop. No session is read
 * and none is set: the same query returns the same public results to everyone.
 *
 * The response is **validated** against the shared contract rather than forwarded. That matters more here
 * than anywhere else so far: a search result set is a mixed union, so a row whose `type` does not match
 * its fields would render as a half-drawn card rather than fail visibly. The discriminated union refuses
 * it here instead.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/search',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SearchHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/** What a search resolved to. `invalid` is the API's 400 — a query too short, or a cursor we did not issue. */
export type SearchLookup =
  | { readonly kind: 'ok'; readonly page: SearchResponse }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** One page of results, a refusal, or a failure. */
export async function readSearch(
  input: {
    q: string;
    locale?: string | undefined;
    cursor?: string | null;
    limit?: string | null;
    /** 8-D's shared filters, forwarded as the validated document rather than as whatever arrived. */
    filters?: CatalogFilters;
  },
  options: SearchHandlerOptions = {},
): Promise<SearchLookup> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  const query = new URLSearchParams({ q: input.q, locale: publicLocaleOf(input.locale) });
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    query.set('cursor', input.cursor);
  }
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    query.set('limit', input.limit);
  }
  for (const [name, value] of catalogFiltersToParams(input.filters ?? {})) query.append(name, value);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/search?${query.toString()}`, { method: 'GET' });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 400) return { kind: 'invalid' };
  if (!upstream.ok) return { kind: 'unavailable' };

  try {
    const result = SearchResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return result.success ? { kind: 'ok', page: result.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Every value a query string carried, with a repeated parameter kept as the list it is — which is how the
 * shared filter parser reads a dimension's alternatives.
 */
function queryRecord(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of new Set(params.keys())) {
    const all = params.getAll(name);
    out[name] = all.length === 1 ? (all[0] ?? '') : all;
  }
  return out;
}

/**
 * `GET /api/search`.
 *
 * A read with no side effect and no session, so there is no Origin check to make: a cross-origin reader
 * learns exactly what any visitor to the public search page already sees.
 */
export async function handleSearch(
  request: Request,
  options: SearchHandlerOptions = {},
): Promise<Response> {
  const params = new URL(request.url).searchParams;

  // The filters are parsed here rather than forwarded, so a parameter this contract does not define cannot
  // cross this origin and a malformed one is refused without an upstream hop.
  const filters = parseCatalogFilters(queryRecord(params));
  if (!filters.ok) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const found = await readSearch(
    {
      q: params.get('q') ?? '',
      locale: params.get('locale') ?? undefined,
      cursor: params.get('cursor'),
      limit: params.get('limit'),
      filters: filters.filters,
    },
    options,
  );

  if (found.kind === 'invalid') {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  if (found.kind === 'unavailable') {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  return new Response(JSON.stringify({ items: found.page.items, nextCursor: found.page.nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
