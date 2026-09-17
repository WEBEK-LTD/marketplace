import { describe, expect, it } from 'vitest';
import { assertFieldsMatchInventory, EnvValidationError as SharedEnvValidationError } from '@repo/server-config';
import { API_ENV_FIELDS, apiConfigLoadedEvent, EnvValidationError, loadEnv } from '../src/config/env.js';

const valid = { NODE_ENV: 'production', API_HOST: '0.0.0.0', API_PORT: '8080' };

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
    expect(env).toEqual({ nodeEnv: 'production', host: '0.0.0.0', port: 8080, logLevel: 'info' });
    expect(Object.isFrozen(env)).toBe(true);
    expect(loadEnv({ ...valid, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('requires NODE_ENV, API_HOST and API_PORT with no defaults', () => {
    expect(errorOf({}).variables).toEqual(['API_HOST', 'API_PORT', 'NODE_ENV']);
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
    expect(apiConfigLoadedEvent()).toEqual({ event: 'config_loaded', component: 'api', variablesValidated: 4 });
  });
});
