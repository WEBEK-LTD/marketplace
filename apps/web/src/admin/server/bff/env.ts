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
