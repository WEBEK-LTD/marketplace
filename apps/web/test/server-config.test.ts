import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig, validateServerConfigAtStartup } from '../src/server/config';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Obviously fake, 43 base64url characters like the real format. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';
/** A reserved test host. No real or intended domain is named anywhere in this repository. */
const ORIGIN = 'https://web.test';

describe('web server configuration', () => {
  it('reads API_BASE_URL, the internal BFF credential and the public origin from the given source', () => {
    expect(
      loadServerConfig({ API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: ORIGIN }),
    ).toEqual({
      apiBaseUrl: 'http://api.internal:8080',
      internalBffCredential: CREDENTIAL,
      publicWebOrigin: ORIGIN,
    });
    expect(() => loadServerConfig({})).toThrow(
      'Invalid or missing environment variables: API_BASE_URL, INTERNAL_BFF_CREDENTIAL',
    );
    expect(() => loadServerConfig({ API_BASE_URL: 'https://api.example' })).toThrow(
      'Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL',
    );
  });

  it('runs without the public origin, and reports it as absent', () => {
    // Deferred until the production domain exists. The app is fully configured without it; only the documents
    // that need an absolute URL stand down.
    const config = loadServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(config.publicWebOrigin).toBeNull();
    expect(config.apiBaseUrl).toBe('https://api.example');
  });

  it('still fails on a public origin that is present and malformed', () => {
    expect(() =>
      loadServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: 'https://web.test/path' }),
    ).toThrow('Invalid or missing environment variables: PUBLIC_WEB_ORIGIN');
  });

  it('reads the process environment by default', () => {
    vi.stubEnv('API_BASE_URL', 'https://api.example');
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
    vi.stubEnv('PUBLIC_WEB_ORIGIN', ORIGIN);
    expect(loadServerConfig().apiBaseUrl).toBe('https://api.example');
    expect(loadServerConfig().publicWebOrigin).toBe(ORIGIN);
  });

  it('logs config_loaded at start-up without values or variable names', () => {
    vi.stubEnv('API_BASE_URL', 'http://placeholder-internal-host:9');
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
    vi.stubEnv('PUBLIC_WEB_ORIGIN', ORIGIN);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    validateServerConfigAtStartup();
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ event: 'config_loaded', component: 'web', variablesValidated: 3 });
    expect(line).not.toMatch(/placeholder-internal-host|API_BASE_URL|INTERNAL_BFF_CREDENTIAL|PUBLIC_WEB_ORIGIN/);
    // The origin is not a secret, but the event carries no values at all, so it is not in there either.
    expect(line).not.toContain(ORIGIN);
    expect(line).not.toContain(CREDENTIAL);
  });

  it('fails start-up validation without API_BASE_URL', () => {
    vi.stubEnv('API_BASE_URL', undefined);
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
    vi.stubEnv('PUBLIC_WEB_ORIGIN', ORIGIN);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(() => validateServerConfigAtStartup()).toThrow('Invalid or missing environment variables: API_BASE_URL');
    expect(info).not.toHaveBeenCalled();
  });
});

describe('server-only alias (R6-1)', () => {
  it('lets tests import server-only modules while React resolves normally', async () => {
    const shimmed = await import('server-only');
    expect(Object.keys(shimmed)).toEqual([]);
    const react = await import('react');
    // The react-server build has no useState; the normal build does.
    expect(typeof react.useState).toBe('function');
  });
});
