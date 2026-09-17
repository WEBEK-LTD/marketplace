import 'server-only';
import { apiClient, configureApiClient } from '@repo/contracts';
import { readApiBaseUrl } from './env';

let configured = false;

/** The generated API client, configured from API_BASE_URL on first use (server-side only). */
export function getApiClient(source?: Readonly<Record<string, string | undefined>>): typeof apiClient {
  if (!configured) {
    configureApiClient({ baseUrl: readApiBaseUrl(source) });
    configured = true;
  }
  return apiClient;
}

/** Test hook. */
export function resetApiClientForTests(): void {
  configured = false;
}
