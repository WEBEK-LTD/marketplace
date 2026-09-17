import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, configureApiClient, resetApiClient } from '../src/index.js';

afterEach(() => resetApiClient());

describe('apiFetch', () => {
  it('refuses to run before configuration', async () => {
    await expect(apiFetch('/health', { method: 'GET' })).rejects.toThrow(/not configured/);
  });

  it('rejects non-http base URLs and relative paths', async () => {
    expect(() => configureApiClient({ baseUrl: 'file:///etc' })).toThrow(TypeError);
    configureApiClient({ baseUrl: 'http://127.0.0.1:1', fetch: vi.fn() as never });
    await expect(apiFetch('health', { method: 'GET' })).rejects.toThrow(TypeError);
  });

  it('joins the base URL and returns data, status and headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"ok"}', { status: 200, headers: { 'x-request-id': 'abc' } }));
    configureApiClient({ baseUrl: 'http://api.internal:8080/', fetch: fetchMock as never });
    const result = await apiFetch<{ data: unknown; status: number; headers: Headers }>('/health', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('http://api.internal:8080/health', { method: 'GET' });
    expect(result.data).toEqual({ status: 'ok' });
    expect(result.status).toBe(200);
    expect(result.headers.get('x-request-id')).toBe('abc');
  });

  it('returns undefined data for an empty body', async () => {
    configureApiClient({ baseUrl: 'http://api.internal', fetch: (async () => new Response(null, { status: 204 })) as never });
    const result = await apiFetch<{ data: unknown; status: number }>('/x', { method: 'GET' });
    expect(result).toMatchObject({ data: undefined, status: 204 });
  });
});
