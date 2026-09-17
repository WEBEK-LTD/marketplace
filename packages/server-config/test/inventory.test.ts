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
    expect(variablesFor('api').map((e) => e.name)).toEqual(['NODE_ENV', 'LOG_LEVEL', 'API_HOST', 'API_PORT']);
    expect(variablesFor('worker').map((e) => e.name)).toEqual([
      'NODE_ENV', 'LOG_LEVEL', 'REDIS_URL', 'WORKER_CONCURRENCY', 'WORKER_HEALTH_HOST', 'WORKER_HEALTH_PORT', 'WORKER_SHUTDOWN_TIMEOUT_MS',
    ]);
    expect(variablesFor('web').map((e) => e.name)).toEqual(['API_BASE_URL']);
    expect(variablesFor('admin').map((e) => e.name)).toEqual(['API_BASE_URL']);
  });

  it('contains no variables for features that are not built yet (R13)', () => {
    const names = ENV_INVENTORY.map((entry) => entry.name).join(' ');
    expect(names).not.toMatch(/DATABASE|SUPABASE|SERVICE_ROLE|PUBLISHABLE|TURNSTILE|SMTP|WABEK|PAYMENT|PAYOUT|BFF_|APP_ENV|OTEL|SENTRY/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ENV_INVENTORY)).toBe(true);
  });
});
