import { describe, expect, it } from 'vitest';
import {
  configLoadedEvent,
  ENV_INVENTORY,
  EnvValidationError,
  httpOrigin,
  httpUrlWithoutCredentials,
  internalBffCredential,
  InventoryDriftError,
  NEXT_SERVER_FIELDS,
  readEnv,
  readNextServerConfig,
  readWebServerConfig,
  WEB_SERVER_FIELDS,
  type FieldValidator,
} from '../src/index.js';

const text: FieldValidator<string> = {
  safeParse: (v) => (typeof v === 'string' && /^\S+$/.test(v) ? { success: true, data: v } : { success: false }),
};
const port: FieldValidator<number> = {
  safeParse: (v) => (typeof v === 'string' && /^[1-9]\d{0,4}$/.test(v) && Number(v) <= 65535 ? { success: true, data: Number(v) } : { success: false }),
};
const apiFields = {
  NODE_ENV: text,
  LOG_LEVEL: text,
  PSEUDONYMOUS_USER_ID_KEY: text,
  API_HOST: text,
  API_PORT: port,
  APP_SYSTEM_DATABASE_URL: text,
  APP_SYSTEM_DATABASE_MAX_CONNECTIONS: port,
  DEVICE_IDENTITY_KEY: text,
  ANALYTICS_SESSION_KEY: text,
  OTP_PEPPER: text,
  WAABEK_BASE_URL: text,
  WAABEK_API_KEY: text,
  INTERNAL_BFF_CREDENTIAL: text,
  SUPABASE_URL: text,
  SUPABASE_SECRET_KEY: text,
  WEB_PUBLIC_ORIGIN: text,
  REDIS_URL: text,
};
const OTP_SECRETS = {
  DEVICE_IDENTITY_KEY: 'device-identity-key-not-a-real-secret-0123456789',
  ANALYTICS_SESSION_KEY: 'analytics-session-key-not-a-real-secret-012345',
  PSEUDONYMOUS_USER_ID_KEY: 'pseudonymous-key-not-a-real-secret-0123456789',
  OTP_PEPPER: 'pepper',
  WAABEK_BASE_URL: 'https://w.invalid',
  WAABEK_API_KEY: 'key',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
  SUPABASE_URL: 'https://project.invalid',
  SUPABASE_SECRET_KEY: 'supabase-secret-not-a-real-key',
  WEB_PUBLIC_ORIGIN: 'https://web.invalid',
  REDIS_URL: 'redis://127.0.0.1:6379',
};
const DB_URL = 'postgresql://app_system@db.invalid:5432/marketplace';

describe('readEnv', () => {
  it('applies inventory defaults only to unset variables and freezes the result', () => {
    const env = readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: '3000', APP_SYSTEM_DATABASE_URL: DB_URL, ...OTP_SECRETS });
    expect(env).toEqual({ NODE_ENV: 'test', LOG_LEVEL: 'info', API_HOST: '127.0.0.1', API_PORT: 3000, APP_SYSTEM_DATABASE_URL: DB_URL, APP_SYSTEM_DATABASE_MAX_CONNECTIONS: 10, ...OTP_SECRETS });
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: 'h', API_PORT: '1', APP_SYSTEM_DATABASE_URL: DB_URL, ...OTP_SECRETS, LOG_LEVEL: '' })).toThrow(EnvValidationError);
  });

  it('lists missing and invalid variables by name only, sorted', () => {
    try {
      readEnv('api', apiFields, { API_PORT: 'secret-looking-value' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).variables).toEqual(['ANALYTICS_SESSION_KEY', 'API_HOST', 'API_PORT', 'APP_SYSTEM_DATABASE_URL', 'DEVICE_IDENTITY_KEY', 'INTERNAL_BFF_CREDENTIAL', 'NODE_ENV', 'OTP_PEPPER', 'PSEUDONYMOUS_USER_ID_KEY', 'REDIS_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_URL', 'WAABEK_API_KEY', 'WAABEK_BASE_URL', 'WEB_PUBLIC_ORIGIN']);
      expect((error as Error).message).toBe('Invalid or missing environment variables: ANALYTICS_SESSION_KEY, API_HOST, API_PORT, APP_SYSTEM_DATABASE_URL, DEVICE_IDENTITY_KEY, INTERNAL_BFF_CREDENTIAL, NODE_ENV, OTP_PEPPER, PSEUDONYMOUS_USER_ID_KEY, REDIS_URL, SUPABASE_SECRET_KEY, SUPABASE_URL, WAABEK_API_KEY, WAABEK_BASE_URL, WEB_PUBLIC_ORIGIN');
      expect(JSON.stringify(error)).not.toContain('secret-looking-value');
    }
  });

  it('refuses a configuration module that drifts from the inventory', () => {
    const { API_PORT: _dropped, ...missing } = apiFields;
    expect(() => readEnv('api', missing, {})).toThrow(InventoryDriftError);
    expect(() => readEnv('api', { ...apiFields, EXTRA_SETTING: text }, {})).toThrow(/not in inventory: EXTRA_SETTING/);
  });

  it('ignores variables that are not in the application inventory', () => {
    // A worker variable, set in the API's environment. `REDIS_URL` no longer serves as this example:
    // the API's login throttle uses it too (C-1), so it is now in both inventories.
    const env = readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: 'h', API_PORT: '1', APP_SYSTEM_DATABASE_URL: DB_URL, ...OTP_SECRETS, WORKER_CONCURRENCY: '5' });
    expect(Object.keys(env)).not.toContain('WORKER_CONCURRENCY');
  });
});

describe('Next.js server configuration', () => {
  /** Obviously fake, 43 base64url characters like the real format. */
  const CREDENTIAL = 'test-current-credential-value-not-a-real-se';
  /** A reserved test host. No real or intended domain appears anywhere in this repository. */
  const ORIGIN = 'https://web.test';

  it('requires an http(s) API_BASE_URL without credentials', () => {
    expect(readWebServerConfig({ API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: ORIGIN })).toEqual({
      apiBaseUrl: 'http://api.internal:8080',
      internalBffCredential: CREDENTIAL,
      publicWebOrigin: ORIGIN,
    });
    expect(readNextServerConfig('admin', { API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL }).apiBaseUrl).toBe('https://api.example');
    for (const bad of [undefined, '', 'not a url', 'ftp://x', 'file:///etc/passwd', 'https://user:placeholder@api.internal', 'https://user@api.internal']) {
      expect(() => readWebServerConfig({ API_BASE_URL: bad, INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: ORIGIN })).toThrow('Invalid or missing environment variables: API_BASE_URL');
    }
    expect(httpUrlWithoutCredentials.safeParse(42).success).toBe(false);
    expect(Object.keys(NEXT_SERVER_FIELDS).sort()).toEqual(['API_BASE_URL', 'INTERNAL_BFF_CREDENTIAL']);
    expect(Object.keys(WEB_SERVER_FIELDS).sort()).toEqual(['API_BASE_URL', 'INTERNAL_BFF_CREDENTIAL', 'PUBLIC_WEB_ORIGIN']);
  });

  it('requires exactly one 43-character base64url internal BFF credential', () => {
    expect(readWebServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: ORIGIN }).internalBffCredential).toBe(CREDENTIAL);
    for (const bad of [
      undefined,
      '',
      'too-short',
      `${CREDENTIAL}x`,
      'test-current-credential-value-not-a-real-s!',
      // A BFF sends only CURRENT. A CURRENT,PREVIOUS pair here would be sent as one header value and
      // refused by the API on every call, so it fails at start-up instead.
      `${CREDENTIAL},test-previous-credential-value-not-a-real-s`,
    ]) {
      expect(() => readWebServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: bad, PUBLIC_WEB_ORIGIN: ORIGIN })).toThrow(
        'Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL',
      );
    }
    expect(internalBffCredential.safeParse(42).success).toBe(false);
  });

  it('never puts a configuration value in the error', () => {
    try {
      readWebServerConfig({ API_BASE_URL: 'https://user:placeholder-pw@api.internal', INTERNAL_BFF_CREDENTIAL: 'placeholder-bad-credential', PUBLIC_WEB_ORIGIN: ORIGIN });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('Invalid or missing environment variables: API_BASE_URL, INTERNAL_BFF_CREDENTIAL');
      expect(JSON.stringify(error)).not.toMatch(/placeholder-pw|placeholder-bad-credential/);
    }
  });

  /**
   * `PUBLIC_WEB_ORIGIN` — the public web's own, required, with no default.
   *
   * It must be an **origin** and not merely a URL, because it is concatenated with site-relative paths to
   * build the absolute URLs the sitemap protocol requires. A trailing slash or a path would quietly produce
   * malformed URLs in a document crawlers read, so the value is refused rather than trimmed.
   *
   * No domain is chosen in this repository, which is why there is no default: an unset variable is a named
   * start-up failure, never a guess.
   */
  /**
   * `PUBLIC_WEB_ORIGIN` — the public web's own, optional, and strict when present.
   *
   * Two separate questions, and the inventory and the validator answer one each. **Must it be there?** No: the
   * production domain is undecided, so the app runs without it and the documents that cannot be built without an
   * absolute URL stay unavailable. **Is a value that IS there acceptable?** Only if it is a bare origin, because
   * it is concatenated with site-relative paths and a trailing slash or a path would quietly produce malformed
   * URLs in a document crawlers read.
   *
   * There is no default and no fallback of any kind — not the request host, not localhost, not a guess.
   */
  it('accepts PUBLIC_WEB_ORIGIN as a bare http(s) origin on the public web', () => {
    expect(
      readWebServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: ORIGIN }).publicWebOrigin,
    ).toBe(ORIGIN);
    expect(httpOrigin.safeParse('http://localhost:3000')).toEqual({ success: true, data: 'http://localhost:3000' });
  });

  it('runs without PUBLIC_WEB_ORIGIN, reporting it as absent rather than guessed', () => {
    const config = readWebServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(config.publicWebOrigin).toBeNull();
    expect(config.apiBaseUrl).toBe('https://api.example');
    // Null means deferred. It is not an empty string, not a host, and not a placeholder something could join to.
    expect(config.publicWebOrigin).not.toBe('');
  });

  it('still refuses a PUBLIC_WEB_ORIGIN that is present and malformed', () => {
    // Optional is about presence, never about what an present value may be: a typo must fail at start-up rather
    // than become a malformed URL in a document other systems treat as authoritative.
    for (const bad of [
      '',
      // A trailing slash, a path, a query or a fragment: not an origin.
      'https://web.test/',
      'https://web.test/site',
      'https://web.test?x=1',
      'https://web.test#x',
      // A default port is normalised away by URL.origin, so the normalised form is the one to configure.
      'https://web.test:443',
      // Not a URL, the wrong scheme, or carrying credentials.
      'web.test',
      'not a url',
      'ftp://web.test',
      'file:///etc/passwd',
      'https://user:placeholder@web.test',
      'https://user@web.test',
    ]) {
      expect(
        () => readWebServerConfig({ API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL, PUBLIC_WEB_ORIGIN: bad }),
        String(bad),
      ).toThrow('Invalid or missing environment variables: PUBLIC_WEB_ORIGIN');
    }
    expect(httpOrigin.safeParse(42).success).toBe(false);
  });

  it('does not ask the admin console for a public origin it has no use for', () => {
    // The admin console is never indexed and has no sitemap, so the variable belongs to one app, not both.
    expect(readNextServerConfig('admin', { API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toEqual({
      apiBaseUrl: 'https://api.example',
      internalBffCredential: CREDENTIAL,
    });
    expect(Object.keys(NEXT_SERVER_FIELDS)).not.toContain('PUBLIC_WEB_ORIGIN');
  });

  it('names no domain of its own', () => {
    // The inventory describes the variable and deliberately supplies no value: no default, no example domain
    // standing in for one, nothing a deployment could inherit by accident.
    const entry = ENV_INVENTORY.find((item) => item.name === 'PUBLIC_WEB_ORIGIN');
    expect(entry).toBeDefined();
    // Deferred: optional, and with no default standing in for a domain nobody has bought.
    expect(entry?.required).toBe(false);
    expect(entry?.default).toBeNull();
    expect(entry?.secret).toBe(false);
    expect(entry?.apps).toEqual(['web']);
  });
});

describe('config_loaded event', () => {
  it('contains only safe metadata: no values and no variable names', () => {
    const event = configLoadedEvent('worker', { A_NAME: text, B_NAME: text });
    expect(event).toEqual({ event: 'config_loaded', component: 'worker', variablesValidated: 2 });
    expect(JSON.stringify(event)).not.toMatch(/A_NAME|B_NAME/);
  });
});
