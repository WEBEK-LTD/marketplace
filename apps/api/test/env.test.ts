import { describe, expect, it } from 'vitest';
import { assertFieldsMatchInventory, EnvValidationError as SharedEnvValidationError } from '@repo/server-config';
import { API_ENV_FIELDS, apiConfigLoadedEvent, EnvValidationError, loadEnv } from '../src/config/env.js';

const valid = {
  NODE_ENV: 'production',
  API_HOST: '0.0.0.0',
  API_PORT: '8080',
  APP_SYSTEM_DATABASE_URL: 'postgresql://app_system@db.invalid:5432/marketplace',
  OTP_PEPPER: 'test-otp-pepper-value-not-a-real-secret-0123456789',
  WAABEK_BASE_URL: 'https://waabek.invalid',
  WAABEK_API_KEY: 'test-waabek-key-not-a-real-secret',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
};

function errorOf(source: Record<string, string | undefined>): EnvValidationError {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected EnvValidationError');
}

describe('environment validation', () => {
  it('parses valid values and defaults LOG_LEVEL to info', () => {
    const env = loadEnv(valid);
    expect(env).toEqual({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      appSystemDatabaseUrl: 'postgresql://app_system@db.invalid:5432/marketplace',
      appSystemDatabaseMaxConnections: 10,
      otpPepper: 'test-otp-pepper-value-not-a-real-secret-0123456789',
      waabekBaseUrl: 'https://waabek.invalid',
      waabekApiKey: 'test-waabek-key-not-a-real-secret',
      internalBffCredentials: ['test-current-credential-value-not-a-real-se'],
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(loadEnv({ ...valid, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('requires NODE_ENV, API_HOST, API_PORT and APP_SYSTEM_DATABASE_URL with no defaults', () => {
    expect(errorOf({}).variables).toEqual([
      'API_HOST',
      'API_PORT',
      'APP_SYSTEM_DATABASE_URL',
      'INTERNAL_BFF_CREDENTIAL',
      'NODE_ENV',
      'OTP_PEPPER',
      'WAABEK_API_KEY',
      'WAABEK_BASE_URL',
    ]);
  });

  it('defaults the app_system pool size', () => {
    expect(loadEnv(valid).appSystemDatabaseMaxConnections).toBe(10);
    expect(loadEnv({ ...valid, APP_SYSTEM_DATABASE_MAX_CONNECTIONS: '25' }).appSystemDatabaseMaxConnections).toBe(25);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['API_HOST', ''],
    ['API_HOST', 'bad host'],
    ['API_PORT', '0'],
    ['API_PORT', '65536'],
    ['API_PORT', '080'],
    ['API_PORT', '80.5'],
    ['API_PORT', 'abc'],
    ['LOG_LEVEL', 'verbose'],
    ['APP_SYSTEM_DATABASE_URL', ''],
    ['APP_SYSTEM_DATABASE_URL', 'mysql://app_system@db.invalid/marketplace'],
    ['APP_SYSTEM_DATABASE_URL', 'db.invalid:5432/marketplace'],
    ['APP_SYSTEM_DATABASE_MAX_CONNECTIONS', '0'],
    ['APP_SYSTEM_DATABASE_MAX_CONNECTIONS', '501'],
    ['APP_SYSTEM_DATABASE_MAX_CONNECTIONS', 'many'],
    ['OTP_PEPPER', 'too-short'],
    ['WAABEK_BASE_URL', 'ftp://waabek.invalid'],
    ['WAABEK_API_KEY', ''],
    ['INTERNAL_BFF_CREDENTIAL', ''],
    ['INTERNAL_BFF_CREDENTIAL', 'too-short'],
    ['INTERNAL_BFF_CREDENTIAL', 'test-current-credential-value-not-a-real-se!'],
    ['INTERNAL_BFF_CREDENTIAL', 'test-current-credential-value-not-a-real-se,test-previous-credential-value-not-a-real-s,test-current-credential-value-not-a-real-se'],
  ])('rejects %s=%j', (name, value) => {
    expect(errorOf({ ...valid, [name]: value }).variables).toEqual([name]);
  });

  it('never includes values in the error message', () => {
    const secretLooking = 'fake-value-that-must-not-be-printed';
    const error = errorOf({ ...valid, API_PORT: secretLooking, API_HOST: `${secretLooking} x` });
    expect(error.message).toBe('Invalid or missing environment variables: API_HOST, API_PORT');
    expect(error.message).not.toContain(secretLooking);
    expect(JSON.stringify(error)).not.toContain(secretLooking);
  });

  it('ignores unrelated variables', () => {
    expect(loadEnv({ ...valid, UNRELATED_SECRET: 'x' })).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('matches the environment inventory and uses the shared error type', () => {
    expect(() => assertFieldsMatchInventory('api', API_ENV_FIELDS)).not.toThrow();
    expect(EnvValidationError).toBe(SharedEnvValidationError);
  });

  it('reads the process environment by default', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, valid);
      expect(loadEnv()).toEqual(loadEnv(valid));
    } finally {
      for (const key of Object.keys(valid)) {
        if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = saved[key];
      }
    }
  });

  it('describes the loaded configuration without values or names', () => {
    expect(apiConfigLoadedEvent()).toEqual({ event: 'config_loaded', component: 'api', variablesValidated: 10 });
  });
});
