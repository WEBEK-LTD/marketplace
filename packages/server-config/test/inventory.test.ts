import { describe, expect, it } from 'vitest';
import { ENV_INVENTORY, variablesFor } from '../src/index.js';

describe('environment inventory', () => {
  it('has unique, well-formed names', () => {
    const names = ENV_INVENTORY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('contains no public (NEXT_PUBLIC_) variables', () => {
    expect(ENV_INVENTORY.some((entry) => entry.name.startsWith('NEXT_PUBLIC_'))).toBe(false);
  });

  it('keeps defaults only on optional variables and never on secrets', () => {
    for (const entry of ENV_INVENTORY) {
      if (entry.default !== null) {
        expect(entry.required).toBe(false);
        expect(entry.secret).toBe(false);
      }
    }
  });

  it('separates runtime variables from tooling variables', () => {
    for (const entry of ENV_INVENTORY) {
      if (entry.status === 'tooling') {
        expect(entry.apps).toEqual(['tooling']);
        expect(entry.environments).not.toContain('production');
        expect(entry.environments).not.toContain('staging');
      } else {
        expect(entry.apps).not.toContain('tooling');
      }
    }
  });

  it('has exactly one client-bundle exception: NODE_ENV (non-secret)', () => {
    const exceptions = ENV_INVENTORY.filter((entry) => entry.clientBundleException !== undefined);
    expect(exceptions.map((entry) => entry.name)).toEqual(['NODE_ENV']);
    expect(exceptions[0]?.secret).toBe(false);
  });

  it('lists the current variables per application', () => {
    expect(variablesFor('api').map((e) => e.name)).toEqual([
      'NODE_ENV',
      'LOG_LEVEL',
      'API_HOST',
      'API_PORT',
      'APP_SYSTEM_DATABASE_URL',
      'APP_SYSTEM_DATABASE_MAX_CONNECTIONS',
      'OTP_PEPPER',
      'WAABEK_BASE_URL',
      'WAABEK_API_KEY',
      'INTERNAL_BFF_CREDENTIAL',
    ]);
    expect(variablesFor('worker').map((e) => e.name)).toEqual([
      'NODE_ENV', 'LOG_LEVEL', 'REDIS_URL', 'WORKER_CONCURRENCY', 'WORKER_HEALTH_HOST', 'WORKER_HEALTH_PORT', 'WORKER_SHUTDOWN_TIMEOUT_MS',
    ]);
    expect(variablesFor('web').map((e) => e.name)).toEqual(['INTERNAL_BFF_CREDENTIAL', 'API_BASE_URL']);
    expect(variablesFor('admin').map((e) => e.name)).toEqual(['INTERNAL_BFF_CREDENTIAL', 'API_BASE_URL']);
  });

  it('contains no variables for features that are not built yet (R13)', () => {
    const names = ENV_INVENTORY.map((entry) => entry.name).join(' ');
    expect(names).not.toMatch(/SUPABASE|SERVICE_ROLE|PUBLISHABLE|TURNSTILE|SMTP|WABEK|PAYMENT|PAYOUT|APP_ENV|OTEL|SENTRY/);
  });

  it('admits exactly two database variables, both for the built app_system connection (R13)', () => {
    // `DATABASE` was forbidden outright while nothing held a database connection. Phase 3 Step 1 gives
    // the API one, so the guard narrows to the two names that connection needs rather than disappearing:
    // any third database variable is a new feature and must be justified here first.
    expect(ENV_INVENTORY.filter((entry) => entry.name.includes('DATABASE')).map((entry) => entry.name)).toEqual([
      'APP_SYSTEM_DATABASE_URL',
      'APP_SYSTEM_DATABASE_MAX_CONNECTIONS',
    ]);
  });

  it('admits exactly the provider and OTP secrets this phase builds (R13)', () => {
    // R13 keeps variables out until their feature exists. The WhatsApp delivery provider and the OTP
    // pepper are built in this phase, so they are admitted by name here rather than by loosening the
    // pattern above: any further provider variable is a new feature and must be justified first.
    expect(
      ENV_INVENTORY.filter((entry) => /WAABEK|WABEK|OTP/.test(entry.name)).map((entry) => entry.name),
    ).toEqual(['OTP_PEPPER', 'WAABEK_BASE_URL', 'WAABEK_API_KEY']);
  });

  it('admits exactly one BFF credential variable, for the built /v1 boundary (R13)', () => {
    // `BFF_` was forbidden outright while no `/v1` route existed. The specification ties the internal
    // BFF credential to "the first step that adds a `/v1` route", which this phase adds, so the guard
    // narrows to the one admitted name rather than dropping the pattern: any second BFF variable is a
    // new feature and must be justified here first.
    expect(ENV_INVENTORY.filter((entry) => entry.name.includes('BFF')).map((entry) => entry.name)).toEqual([
      'INTERNAL_BFF_CREDENTIAL',
    ]);
  });

  it('keeps the internal BFF credential a server-only secret that can never reach a browser', () => {
    const entry = ENV_INVENTORY.find((candidate) => candidate.name === 'INTERNAL_BFF_CREDENTIAL');
    expect(entry?.secret).toBe(true);
    expect(entry?.required).toBe(true);
    // Both sides of the C-2d boundary: the API enforces it, web and admin present it from their server
    // runtimes. It is declared for no other application, and never for a browser.
    expect(entry?.apps).toEqual(['api', 'web', 'admin']);
    expect(entry?.apps).not.toContain('tooling');
    expect(entry?.apps).not.toContain('worker');
    // No client-bundle excuse, and never a NEXT_PUBLIC_ name: check:client-env scans every inventory
    // name against the built client bundles, so this entry is what makes that check cover the credential.
    expect(entry?.clientBundleException).toBeUndefined();
    expect(entry?.name.startsWith('NEXT_PUBLIC_')).toBe(false);
  });

  it('gives web and admin no variable that is not server-only', () => {
    // Neither Next.js app may hold a variable a browser could read: both are BFF runtimes.
    for (const app of ['web', 'admin'] as const) {
      for (const entry of variablesFor(app)) {
        expect(entry.name.startsWith('NEXT_PUBLIC_'), `${app}/${entry.name}`).toBe(false);
        expect(entry.clientBundleException, `${app}/${entry.name}`).toBeUndefined();
      }
    }
  });

  it('marks the OTP pepper and the Waabek key as required server-side secrets', () => {
    for (const name of ['OTP_PEPPER', 'WAABEK_API_KEY']) {
      const entry = ENV_INVENTORY.find((candidate) => candidate.name === name);
      expect(entry?.secret, name).toBe(true);
      expect(entry?.required, name).toBe(true);
      expect(entry?.apps, name).toEqual(['api']);
      // Neither may ever be excused into a browser bundle.
      expect(entry?.clientBundleException, name).toBeUndefined();
      expect(name.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });

  it('marks the app_system connection string as a secret', () => {
    const url = ENV_INVENTORY.find((entry) => entry.name === 'APP_SYSTEM_DATABASE_URL');
    expect(url?.secret).toBe(true);
    expect(url?.required).toBe(true);
    // It must never be listed as a client-bundle exception: a connection string cannot reach a browser.
    expect(url?.clientBundleException).toBeUndefined();
    expect(url?.apps).toEqual(['api']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ENV_INVENTORY)).toBe(true);
  });
});
