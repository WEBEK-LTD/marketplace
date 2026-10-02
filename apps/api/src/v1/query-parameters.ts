/**
 * The whole query string, as a record.
 *
 * Most routes name the parameters they take, which is clearer and is why they do. The catalogue filters
 * cannot: a dimension arrives repeated (`tag=a&tag=b`), and an attribute arrives under a name only the
 * vocabulary knows (`attr.material=oak`), so there is no fixed set of names to decorate. The shared parser
 * in `@repo/contracts` is what judges the shape; this is only the reading.
 *
 * Fastify has already parsed the query string by the time a handler runs, so nothing is re-parsed here and
 * no URL is reconstructed. A value Fastify gives as something other than a string or an array of strings is
 * dropped rather than coerced: the parser's job is to refuse what it does not recognise, and handing it a
 * shape it cannot refuse would defeat that.
 */

/** Fastify's request, reduced to the one thing these routes read. */
export interface QueryBearingRequest {
  readonly query?: unknown;
}

export function queryParameters(
  request: QueryBearingRequest,
): Readonly<Record<string, string | readonly string[] | undefined>> {
  const query = request.query;
  if (typeof query !== 'object' || query === null) return {};

  const out: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      out[name] = value as string[];
    }
  }
  return out;
}
