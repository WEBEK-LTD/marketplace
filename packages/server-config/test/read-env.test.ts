import { describe, expect, it } from 'vitest';
import {
  configLoadedEvent,
  EnvValidationError,
  httpUrlWithoutCredentials,
  internalBffCredential,
  InventoryDriftError,
  NEXT_SERVER_FIELDS,
  readEnv,
  readNextServerConfig,
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
  API_HOST: text,
  API_PORT: port,
  APP_SYSTEM_DATABASE_URL: text,
  APP_SYSTEM_DATABASE_MAX_CONNECTIONS: port,
  OTP_PEPPER: text,
  WAABEK_BASE_URL: text,
  WAABEK_API_KEY: text,
  INTERNAL_BFF_CREDENTIAL: text,
};
const OTP_SECRETS = { OTP_PEPPER: 'pepper', WAABEK_BASE_URL: 'https://w.invalid', WAABEK_API_KEY: 'key', INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se' };
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
      expect((error as EnvValidationError).variables).toEqual(['API_HOST', 'API_PORT', 'APP_SYSTEM_DATABASE_URL', 'INTERNAL_BFF_CREDENTIAL', 'NODE_ENV', 'OTP_PEPPER', 'WAABEK_API_KEY', 'WAABEK_BASE_URL']);
      expect((error as Error).message).toBe('Invalid or missing environment variables: API_HOST, API_PORT, APP_SYSTEM_DATABASE_URL, INTERNAL_BFF_CREDENTIAL, NODE_ENV, OTP_PEPPER, WAABEK_API_KEY, WAABEK_BASE_URL');
      expect(JSON.stringify(error)).not.toContain('secret-looking-value');
    }
  });

  it('refuses a configuration module that drifts from the inventory', () => {
    const { API_PORT: _dropped, ...missing } = apiFields;
    expect(() => readEnv('api', missing, {})).toThrow(InventoryDriftError);
    expect(() => readEnv('api', { ...apiFields, EXTRA_SETTING: text }, {})).toThrow(/not in inventory: EXTRA_SETTING/);
  });

  it('ignores variables that are not in the application inventory', () => {
    const env = readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: 'h', API_PORT: '1', APP_SYSTEM_DATABASE_URL: DB_URL, ...OTP_SECRETS, REDIS_URL: 'redis://x' });
    expect(Object.keys(env)).not.toContain('REDIS_URL');
  });
});

describe('Next.js server configuration', () => {
  /** Obviously fake, 43 base64url characters like the real format. */
  const CREDENTIAL = 'test-current-credential-value-not-a-real-se';

  it('requires an http(s) API_BASE_URL without credentials', () => {
    expect(readNextServerConfig('web', { API_BASE_URL: 'http://api.internal:8080', INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toEqual({
      apiBaseUrl: 'http://api.internal:8080',
      internalBffCredential: CREDENTIAL,
    });
    expect(readNextServerConfig('admin', { API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL }).apiBaseUrl).toBe('https://api.example');
    for (const bad of [undefined, '', 'not a url', 'ftp://x', 'file:///etc/passwd', 'https://user:placeholder@api.internal', 'https://user@api.internal']) {
      expect(() => readNextServerConfig('web', { API_BASE_URL: bad, INTERNAL_BFF_CREDENTIAL: CREDENTIAL })).toThrow('Invalid or missing environment variables: API_BASE_URL');
    }
    expect(httpUrlWithoutCredentials.safeParse(42).success).toBe(false);
    expect(Object.keys(NEXT_SERVER_FIELDS).sort()).toEqual(['API_BASE_URL', 'INTERNAL_BFF_CREDENTIAL']);
  });

  it('requires exactly one 43-character base64url internal BFF credential', () => {
    expect(readNextServerConfig('web', { API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: CREDENTIAL }).internalBffCredential).toBe(CREDENTIAL);
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
      expect(() => readNextServerConfig('web', { API_BASE_URL: 'https://api.example', INTERNAL_BFF_CREDENTIAL: bad })).toThrow(
        'Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL',
      );
    }
    expect(internalBffCredential.safeParse(42).success).toBe(false);
  });

  it('never puts a configuration value in the error', () => {
    try {
      readNextServerConfig('web', { API_BASE_URL: 'https://user:placeholder-pw@api.internal', INTERNAL_BFF_CREDENTIAL: 'placeholder-bad-credential' });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('Invalid or missing environment variables: API_BASE_URL, INTERNAL_BFF_CREDENTIAL');
      expect(JSON.stringify(error)).not.toMatch(/placeholder-pw|placeholder-bad-credential/);
    }
  });
});

describe('config_loaded event', () => {
  it('contains only safe metadata: no values and no variable names', () => {
    const event = configLoadedEvent('worker', { A_NAME: text, B_NAME: text });
    expect(event).toEqual({ event: 'config_loaded', component: 'worker', variablesValidated: 2 });
    expect(JSON.stringify(event)).not.toMatch(/A_NAME|B_NAME/);
  });
});
