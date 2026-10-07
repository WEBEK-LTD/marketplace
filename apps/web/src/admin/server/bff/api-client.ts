import 'server-only';
import { apiClient, configureApiClient } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

let configured = false;

/**
 * The generated API client, configured from the server environment on first use (server-side only).
 *
 * The credential reaches the client through the `fetch` option that `@repo/contracts` already exposes,
 * so the contracts package stays unaware of the credential and of the header — it is handed a `fetch`
 * and calls it. That seam is what keeps a server-only secret out of the package the browser code
 * depends on.
 */
export function getApiClient(source?: Readonly<Record<string, string | undefined>>): typeof apiClient {
  if (!configured) {
    const config = readBffConfig(source);
    configureApiClient({
      baseUrl: config.apiBaseUrl,
      fetch: createInternalCredentialFetch(config.internalBffCredential),
    });
    configured = true;
  }
  return apiClient;
}

/** Test hook. */
export function resetApiClientForTests(): void {
  configured = false;
}
