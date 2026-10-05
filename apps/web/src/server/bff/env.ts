import 'server-only';
import { EnvValidationError } from '@repo/server-config';
import { loadServerConfig } from '../config';

/**
 * Server-only BFF configuration. No NEXT_PUBLIC_ variables exist.
 *
 * The error names the variables that failed and never their values, so a bad `API_BASE_URL` containing
 * a password and a malformed `INTERNAL_BFF_CREDENTIAL` are both reported by name alone.
 */
export class BffConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'BffConfigError';
    this.variables = variables;
  }
}

/** Reads and validates everything the BFF needs to call the API. Throws before any request is made. */
export function readBffConfig(source?: Readonly<Record<string, string | undefined>>): {
  readonly apiBaseUrl: string;
  readonly internalBffCredential: string;
  readonly publicWebOrigin: string | null;
} {
  try {
    return loadServerConfig(source);
  } catch (error) {
    if (error instanceof EnvValidationError) throw new BffConfigError(error.variables);
    throw error;
  }
}

export function readApiBaseUrl(source?: Readonly<Record<string, string | undefined>>): string {
  return readBffConfig(source).apiBaseUrl;
}

/**
 * The public origin, or `null` while no production domain is configured.
 *
 * Only the sitemap and `robots.txt` call this. The sitemap protocol requires absolute URLs, and the `Sitemap:`
 * directive in `robots.txt` requires one, while every link a page renders stays site-relative.
 *
 * The value comes from configuration and from nowhere else. It is **never** derived from the request `Host`
 * header, from `X-Forwarded-Host`, or from a guess at localhost: a client controls those, so a poisoned one
 * would publish a sitemap advertising somebody else's origin — and a sitemap is a document other systems treat
 * as authoritative. So `null` means the documents that need an absolute URL stay unavailable, and that is the
 * whole of the fallback behaviour.
 */
export function readPublicWebOrigin(source?: Readonly<Record<string, string | undefined>>): string | null {
  return readBffConfig(source).publicWebOrigin;
}
