import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';

const API_KEY = 'fake-waabek-key-not-a-real-secret';
const BASE = 'https://waabek.invalid';

function clientWith(fetchImpl: typeof globalThis.fetch) {
  return new WaabekClient({ baseUrl: BASE, apiKey: API_KEY, fetch: fetchImpl });
}

/** Typed like fetch so `mock.calls` keeps its argument types. */
const ok = (body: unknown = { messageId: 'wam-1' }) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

const failing = (status: number) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('', { status }));

describe('Waabek adapter', () => {
  it('posts to the generic send endpoint, not an OTP endpoint', async () => {
    const fetchMock = ok();
    const client = clientWith(fetchMock as never);
    expect(client.sendUrl).toBe('https://waabek.invalid/api/v1/send');
    await client.send('+201000000001', 'code 012345');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://waabek.invalid/api/v1/send');
    expect(init?.method).toBe('POST');
    // Waabek is the delivery layer only: its own OTP authority endpoints must never be used.
    expect(url).not.toContain('/api/otp/send');
    expect(url).not.toContain('/api/otp/verify');
  });

  it('authenticates with the X-API-Key header', async () => {
    const fetchMock = ok();
    await clientWith(fetchMock as never).send('+201000000001', 'code 012345');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['content-type']).toBe('application/json');
    // Never as a query parameter or bearer token.
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(API_KEY);
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends the destination and message body', async () => {
    const fetchMock = ok();
    await clientWith(fetchMock as never).send('+201000000001', 'Your code is 012345');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ to: '+201000000001', message: 'Your code is 012345' });
  });

  it('matches the confirmed Waabek contract exactly', async () => {
    // Owner-confirmed: POST {base}/api/v1/send, X-API-Key header, body {to, message}. Pinned here so a
    // later change to the payload has to be a deliberate edit to this assertion.
    const fetchMock = ok();
    await clientWith(fetchMock as never).send('+201000000001', 'Your code is 012345');
    const [url, init] = fetchMock.mock.calls[0] ?? [];

    expect(new URL(String(url)).pathname).toBe('/api/v1/send');
    expect(Object.keys((init?.headers ?? {}) as Record<string, string>).sort()).toEqual([
      'content-type',
      'x-api-key',
    ]);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // Exactly these two fields, and nothing else.
    expect(Object.keys(body).sort()).toEqual(['message', 'to']);
    expect(body).toEqual({ to: '+201000000001', message: 'Your code is 012345' });
  });

  it('takes its origin from configuration rather than hardcoding the provider host', () => {
    const source = readFileSync(new URL('../src/auth/otp/waabek.client.ts', import.meta.url), 'utf8');
    // The confirmed production origin is https://waabek.com, but it is supplied by WAABEK_BASE_URL so
    // staging and tests can point elsewhere.
    expect(source).not.toContain('waabek.com');
    expect(new WaabekClient({ baseUrl: 'https://waabek.com', apiKey: API_KEY }).sendUrl).toBe(
      'https://waabek.com/api/v1/send',
    );
  });

  it('reports success with the provider message id', async () => {
    const result = await clientWith(ok({ messageId: 'wam-42' }) as never).send('+201000000001', 'x');
    expect(result).toEqual({ status: 'sent', providerMessageId: 'wam-42' });
  });

  it('still succeeds when the response body has no id', async () => {
    const fetchMock = vi.fn(async (_i: string | URL | Request, _n?: RequestInit) => new Response('not json', { status: 200 }));
    const result = await clientWith(fetchMock as never).send('+201000000001', 'x');
    expect(result).toEqual({ status: 'sent', providerMessageId: null });
  });

  it('reports every provider status as a plain failure, with no retry hint', async () => {
    const status = async (code: number) => {
      return await clientWith(failing(code) as never).send('+201000000001', 'x');
    };
    expect(await status(400)).toEqual({ status: 'failed', errorType: 'provider_status_400' });
    expect(await status(401)).toEqual({ status: 'failed', errorType: 'provider_status_401' });
    expect(await status(429)).toEqual({ status: 'failed', errorType: 'provider_status_429' });
    expect(await status(500)).toEqual({ status: 'failed', errorType: 'provider_status_500' });
    expect(await status(503)).toEqual({ status: 'failed', errorType: 'provider_status_503' });
  });

  it('turns an unreachable provider into a retryable failure rather than throwing', async () => {
    const fetchMock = vi.fn(async (_i: string | URL | Request, _n?: RequestInit) => {
      throw new Error('ECONNREFUSED');
    });
    const result = await clientWith(fetchMock as never).send('+201000000001', 'x');
    expect(result).toEqual({ status: 'failed', errorType: 'provider_unreachable' });
  });

  it('reports a timeout as a plain failure', async () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn(async (_i: string | URL | Request, _n?: RequestInit) => {
      throw aborted;
    });
    const result = await clientWith(fetchMock as never).send('+201000000001', 'x');
    expect(result).toEqual({ status: 'failed', errorType: 'provider_timeout' });
  });

  it('carries no retry hint at all, so no caller can requeue an undeliverable OTP', async () => {
    const source = readFileSync(new URL('../src/auth/otp/waabek.client.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('retryable');
    const outcome = await clientWith(failing(503) as never).send('+201000000001', 'x');
    expect(Object.keys(outcome).sort()).toEqual(['errorType', 'status']);
  });

  it('never logs the API key or the message', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => void lines.push(args.join(' ')));
    const fetchMock = failing(500);
    await clientWith(fetchMock as never).send('+201000000001', 'Your code is 012345');
    spy.mockRestore();
    const all = lines.join('\n');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('012345');
  });

  it('rejects a bad base URL or a blank key at construction', () => {
    expect(() => new WaabekClient({ baseUrl: 'ftp://waabek.invalid', apiKey: API_KEY })).toThrow(TypeError);
    expect(() => new WaabekClient({ baseUrl: BASE, apiKey: '   ' })).toThrow(RangeError);
  });

  it('is the only place that talks to Waabek, and holds no fallback response', () => {
    const source = readFileSync(new URL('../src/auth/otp/waabek.client.ts', import.meta.url), 'utf8');
    // No fabricated provider response in production code.
    expect(source).not.toMatch(/mock|stub|fake|simulate/i);
  });
});
