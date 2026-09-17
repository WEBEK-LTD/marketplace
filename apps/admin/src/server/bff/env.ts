import 'server-only';
import { EnvValidationError } from '@repo/server-config';
import { loadServerConfig } from '../config';

/** Server-only BFF configuration. No NEXT_PUBLIC_ variables exist. */
export class BffConfigError extends Error {
  constructor() {
    super('Invalid or missing environment variable: API_BASE_URL');
    this.name = 'BffConfigError';
  }
}

export function readApiBaseUrl(source?: Readonly<Record<string, string | undefined>>): string {
  try {
    return loadServerConfig(source).apiBaseUrl;
  } catch (error) {
    if (error instanceof EnvValidationError) throw new BffConfigError();
    throw error;
  }
}
