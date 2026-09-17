/**
 * Fetch function used by the generated client.
 * The base URL must be configured once by the server-side caller (the BFF).
 */
export interface ApiClientConfig {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

let config: ApiClientConfig | undefined;

export function configureApiClient(next: ApiClientConfig): void {
  const url = new URL(next.baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('API base URL must use http or https.');
  }
  config = Object.freeze({ ...next, baseUrl: url.toString().replace(/\/$/, '') });
}

export function resetApiClient(): void {
  config = undefined;
}

export async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
  if (config === undefined) {
    throw new Error('API client is not configured. Call configureApiClient first.');
  }
  if (!path.startsWith('/')) {
    throw new TypeError('API paths must start with "/".');
  }
  const fetchImpl = config.fetch ?? fetch;
  const response = await fetchImpl(`${config.baseUrl}${path}`, init);
  const text = await response.text();
  const data: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { data, status: response.status, headers: response.headers } as T;
}
