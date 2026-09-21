import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig, validateServerConfigAtStartup } from '../src/server/config';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Obviously fake, 43 base64url characters like the real format. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';

describe('admin server configuration', () => {
  it('reads API_BASE_URL and the internal BFF credential from the given source', () => {
    expect(loadServerConfig({ API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toEqual({
      apiBaseUrl: 'http://api.internal:8080',
      internalBffCredential: CREDENTIAL,
    });
    expect(() => loadServerConfig({})).toThrow('Invalid or missing environment variables: API_BASE_URL, INTERNAL_BFF_CREDENTIAL');
    expect(() => loadServerConfig({ API_BASE_URL: 'https://api.example' })).toThrow('Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL');
  });

  it('reads the process environment by default', () => {
    vi.stubEnv('API_BASE_URL', 'https://api.example');
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
    expect(loadServerConfig().apiBaseUrl).toBe('https://api.example');
  });

  it('logs config_loaded at start-up without values or variable names', () => {
    vi.stubEnv('API_BASE_URL', 'http://placeholder-internal-host:9');
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    validateServerConfigAtStartup();
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ event: 'config_loaded', component: 'admin', variablesValidated: 2 });
    expect(line).not.toMatch(/placeholder-internal-host|API_BASE_URL|INTERNAL_BFF_CREDENTIAL/);
    expect(line).not.toContain(CREDENTIAL);
  });

  it('fails start-up validation without API_BASE_URL', () => {
    vi.stubEnv('API_BASE_URL', undefined);
    vi.stubEnv('INTERNAL_BFF_CREDENTIAL', CREDENTIAL);
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
