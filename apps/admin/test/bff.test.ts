import { describe, expect, it } from 'vitest';
import { resetApiClientForTests } from '../src/server/bff/api-client';
import { BffConfigError, checkSameOrigin, getApiClient, readApiBaseUrl } from '../src/server/bff/index';

/** Obviously fake, 43 base64url characters like the real format. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';

describe('API_BASE_URL', () => {
  it('accepts http and https URLs', () => {
    expect(readApiBaseUrl({ API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toBe('http://api.internal:8080');
    expect(readApiBaseUrl({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toBe('https://api.example');
  });

  it.each([undefined, '', 'not a url', 'ftp://api.internal', 'file:///etc/passwd', 'https://user:secret-pw@api.internal'])(
    'rejects %j without revealing the value',
    (value) => {
      try {
        readApiBaseUrl({ API_BASE_URL: value, INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(BffConfigError);
        expect((error as Error).message).toBe('Invalid or missing environment variables: API_BASE_URL');
        expect(JSON.stringify(error)).not.toContain('secret-pw');
      }
    },
  );

  it('configures the generated API client on first use', () => {
    resetApiClientForTests();
    expect(() => getApiClient({})).toThrow(BffConfigError);
    const client = getApiClient({ API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(typeof client.getHealth).toBe('function');
    expect(typeof client.getReadiness).toBe('function');
    resetApiClientForTests();
  });
});

describe('Origin/CSRF check', () => {
  const request = (method: string, headers: Record<string, string>) => ({
    method,
    url: 'https://www.example.test/api/bff/x',
    headers: new Headers(headers),
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('allows the safe method %s without an Origin', (method) => {
    expect(checkSameOrigin(request(method, {}))).toEqual({ ok: true });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allows %s from the same origin', (method) => {
    expect(checkSameOrigin(request(method, { origin: 'https://www.example.test' }))).toEqual({ ok: true });
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['another port', 'https://www.example.test:8443'],
    ['http downgrade', 'http://www.example.test'],
    ['a subdomain', 'https://evil.www.example.test'],
    ['the null origin', 'null'],
  ])('rejects a POST from %s', (_label, origin) => {
    expect(checkSameOrigin(request('POST', { origin }))).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  it('accepts a missing Origin only with Sec-Fetch-Site: same-origin', () => {
    expect(checkSameOrigin(request('POST', { 'sec-fetch-site': 'same-origin' }))).toEqual({ ok: true });
    expect(checkSameOrigin(request('POST', { 'sec-fetch-site': 'cross-site' }))).toEqual({ ok: false, reason: 'missing_origin' });
    expect(checkSameOrigin(request('POST', { 'sec-fetch-site': 'same-site' }))).toEqual({ ok: false, reason: 'missing_origin' });
    expect(checkSameOrigin(request('POST', {}))).toEqual({ ok: false, reason: 'missing_origin' });
  });
});
