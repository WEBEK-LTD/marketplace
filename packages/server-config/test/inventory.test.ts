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
      'PSEUDONYMOUS_USER_ID_KEY',
      'API_HOST',
      'API_PORT',
      'APP_SYSTEM_DATABASE_URL',
      'APP_SYSTEM_DATABASE_MAX_CONNECTIONS',
      'DEVICE_IDENTITY_KEY',
      // 0101: its own key, next to the other two and never one of them.
      'ANALYTICS_SESSION_KEY',
      'OTP_PEPPER',
      'WAABEK_BASE_URL',
      'WAABEK_API_KEY',
      'INTERNAL_BFF_CREDENTIAL',
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
      'WEB_PUBLIC_ORIGIN',
      'REDIS_URL',
    ]);
    expect(variablesFor('worker').map((e) => e.name)).toEqual([
      'NODE_ENV', 'LOG_LEVEL', 'PSEUDONYMOUS_USER_ID_KEY', 'REDIS_URL', 'WORKER_CONCURRENCY', 'WORKER_HEALTH_HOST', 'WORKER_HEALTH_PORT', 'WORKER_SHUTDOWN_TIMEOUT_MS',
      // Phase 7-D: the outbox relay's own connection and its polling cadence.
      'APP_WORKER_DATABASE_URL', 'APP_WORKER_DATABASE_MAX_CONNECTIONS', 'EMAIL_RELAY_INTERVAL_MS',
      // Phase 8-A: the transactional outbox relay and its sweeper. Cadence only — what may be claimed
      // is the handler registry's decision, and the staleness threshold is the database function's own.
      'OUTBOX_RELAY_INTERVAL_MS', 'OUTBOX_SWEEPER_INTERVAL_MS',
    ]);
    // One Next.js deployment since 0108, serving the marketplace at `/` and the staff console at `/admin`. Its
    // three variables cover both surfaces: the internal credential, the API address, and the public origin the
    // sitemap and robots documents are built from.
    expect(variablesFor('web').map((e) => e.name)).toEqual(['INTERNAL_BFF_CREDENTIAL', 'API_BASE_URL', 'PUBLIC_WEB_ORIGIN']);
    // And the console is not an app of its own in the inventory. That is the assertion, not an omission: a row
    // keyed to it would describe a second environment that nobody provisions and no process reads.
  });

  it('contains no variables for features that are not built yet (R13)', () => {
    const names = ENV_INVENTORY.map((entry) => entry.name).join(' ');
    expect(names).not.toMatch(/SERVICE_ROLE|PUBLISHABLE|TURNSTILE|SMTP|WABEK|PAYMENT|PAYOUT|APP_ENV|OTEL|SENTRY/);
  });

  it('admits exactly the two Supabase variables the login flow builds (R13)', () => {
    // `SUPABASE` was forbidden outright while nothing signed anyone in. F2 gives the API a server-side
    // password sign-in, so the guard narrows to the two names that call needs rather than disappearing.
    // `SERVICE_ROLE` and `PUBLISHABLE` stay forbidden above: no browser-facing Supabase key is built,
    // and the browser never speaks to Supabase at all.
    expect(ENV_INVENTORY.filter((entry) => entry.name.includes('SUPABASE')).map((entry) => entry.name)).toEqual([
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
    ]);
    const secret = ENV_INVENTORY.find((entry) => entry.name === 'SUPABASE_SECRET_KEY');
    expect(secret?.secret).toBe(true);
    expect(secret?.apps).toEqual(['api']);
  });

  it('shares one Redis variable between the worker and the API login throttle (C-1)', () => {
    const entry = ENV_INVENTORY.find((candidate) => candidate.name === 'REDIS_URL');
    expect(entry?.apps).toEqual(['api', 'worker']);
    expect(entry?.secret).toBe(true);
    expect(entry?.required).toBe(true);
  });

  it('admits exactly two database connections, one per role that holds one (R13)', () => {
    // `DATABASE` was forbidden outright while nothing held a database connection. Phase 3 Step 1 gives
    // the API one and Phase 7-D gives the worker one, so the guard narrows to the names those two
    // connections need rather than disappearing: any further database variable is a new feature and
    // must be justified here first.
    //
    // Two roles, deliberately two variables. `app_system` and `app_worker` are separate login roles
    // with separate EXECUTE grants (migrations 0003 and 0008), and sharing one connection string
    // between them would collapse that separation into a convention.
    expect(ENV_INVENTORY.filter((entry) => entry.name.includes('DATABASE')).map((entry) => entry.name)).toEqual([
      'APP_SYSTEM_DATABASE_URL',
      'APP_SYSTEM_DATABASE_MAX_CONNECTIONS',
      'APP_WORKER_DATABASE_URL',
      'APP_WORKER_DATABASE_MAX_CONNECTIONS',
    ]);
    const workerUrl = ENV_INVENTORY.find((entry) => entry.name === 'APP_WORKER_DATABASE_URL');
    expect(workerUrl?.apps).toEqual(['worker']);
    expect(workerUrl?.secret).toBe(true);
    expect(workerUrl?.required).toBe(true);
  });

  it('admits the email relay cadence and no email provider credential (R13)', () => {
    // Phase 7-D builds the delivery layer and chooses no provider, so the only email variable is the
    // relay's polling cadence: transport, not a credential and not a business rule. `SMTP` stays
    // forbidden outright by the R13 guard below, and any provider key is a new feature.
    expect(ENV_INVENTORY.filter((entry) => /EMAIL|MAIL/.test(entry.name)).map((entry) => entry.name)).toEqual([
      'EMAIL_RELAY_INTERVAL_MS',
    ]);
    const relay = ENV_INVENTORY.find((entry) => entry.name === 'EMAIL_RELAY_INTERVAL_MS');
    expect(relay?.secret).toBe(false);
    expect(relay?.required).toBe(false);
    expect(relay?.default).toBe('15000');
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
    // One Next.js deployment since 0108: the API enforces the boundary, and the single BFF runtime presents the
    // credential on behalf of both of its surfaces.
    expect(entry?.apps).toEqual(['api', 'web']);
    expect(entry?.apps).not.toContain('tooling');
    expect(entry?.apps).not.toContain('worker');
    // No client-bundle excuse, and never a NEXT_PUBLIC_ name: check:client-env scans every inventory
    // name against the built client bundles, so this entry is what makes that check cover the credential.
    expect(entry?.clientBundleException).toBeUndefined();
    expect(entry?.name.startsWith('NEXT_PUBLIC_')).toBe(false);
  });

  it('gives the Next.js deployment no variable that is not server-only', () => {
    // The Next.js runtime may hold no variable a browser could read: it is a BFF, on both of its surfaces.
    for (const entry of variablesFor('web')) {
      expect(entry.name.startsWith('NEXT_PUBLIC_'), entry.name).toBe(false);
      expect(entry.clientBundleException, entry.name).toBeUndefined();
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
