import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadServerConfig } from '../../src/admin/server/config';
import { loadServerConfig as loadWebServerConfig } from '../../src/server/config';
import * as consoleConfig from '../../src/admin/server/config';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Obviously fake, 43 base64url characters like the real format. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';

/**
 * The console reads the deployment's configuration, not a configuration of its own (0108).
 *
 * Until 0108 the console was an application and had its own reader, its own start-up validation and its own
 * `config_loaded` log line naming `admin` as the component. One deployment has one environment, so all three of
 * those collapsed into the web app's — `test/startup.test.ts` and `test/server-config.test.ts` assert them for the
 * one runtime, including the single `config_loaded` line and its three validated variables.
 *
 * What is left here is the part that is specifically about the console, and specifically worth protecting: that it
 * goes through the deployment's one reader rather than reading the environment a second time, and that the two
 * fields its BFF depends on still arrive. A second reader would not fail a typecheck and would not fail the web
 * suite — it would simply mean two places that could disagree about the same process environment.
 *
 * The matching start-up and telemetry suites for the old admin application were removed rather than re-rooted,
 * because their subject was a second application's `start` script and a second `serviceName`, and there is no
 * second application. No assertion they made about the console's behaviour is unasserted: every one of them is
 * made by the surviving app's own suites, for the runtime that actually boots.
 */
describe('the console reads the deployment configuration', () => {
  it('is the deployment’s one reader, not a second one', () => {
    // Identity, not equivalence. Two readers that behave alike today are two readers that can drift tomorrow.
    expect(loadServerConfig).toBe(loadWebServerConfig);
  });

  it('yields the two fields the console’s BFF depends on', () => {
    const config = loadServerConfig({
      API_BASE_URL: 'http://api.internal:8080',
      INTERNAL_BFF_CREDENTIAL: CREDENTIAL,
    });
    expect(config.apiBaseUrl).toBe('http://api.internal:8080');
    expect(config.internalBffCredential).toBe(CREDENTIAL);
  });

  it('refuses an incomplete environment, naming what is missing and nothing else', () => {
    expect(() => loadServerConfig({})).toThrow(
      'Invalid or missing environment variables: API_BASE_URL, INTERNAL_BFF_CREDENTIAL',
    );
    expect(() => loadServerConfig({ API_BASE_URL: 'https://api.example' })).toThrow(
      'Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL',
    );
  });

  it('exposes no start-up validation of its own, so there is one start-up log line', () => {
    // A second entry point would mean a second `config_loaded` line claiming a component that does not boot.
    expect(Object.keys(consoleConfig)).toEqual(['loadServerConfig']);
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
