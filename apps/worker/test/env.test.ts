import { describe, expect, it } from 'vitest';
import { assertFieldsMatchInventory, variablesFor } from '@repo/server-config';
import { DEFAULT_CONCURRENCY, DEFAULT_SHUTDOWN_TIMEOUT_MS, EnvValidationError, loadEnv, WORKER_ENV_FIELDS, workerConfigLoadedEvent } from '../src/config/env.js';

const base = {
  NODE_ENV: 'development',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WORKER_HEALTH_HOST: '0.0.0.0',
  WORKER_HEALTH_PORT: '8081',
};

function invalid(source: Record<string, string | undefined>): EnvValidationError {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected EnvValidationError');
}

describe('worker environment', () => {
  it('parses valid values with the approved defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      nodeEnv: 'development',
      logLevel: 'info',
      concurrency: DEFAULT_CONCURRENCY,
      health: { host: '0.0.0.0', port: 8081 },
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    });
    expect(DEFAULT_CONCURRENCY).toBe(5);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(25_000);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('requires NODE_ENV, REDIS_URL, WORKER_HEALTH_HOST and WORKER_HEALTH_PORT', () => {
    expect(invalid({}).variables).toEqual(['NODE_ENV', 'REDIS_URL', 'WORKER_HEALTH_HOST', 'WORKER_HEALTH_PORT']);
  });

  it('accepts redis:// only in development and test', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).redisUrl).toBe('redis://127.0.0.1:6379');
    expect(invalid({ ...base, NODE_ENV: 'production' }).variables).toEqual(['REDIS_URL']);
  });

  it('requires rediss:// with a password in production', () => {
    const ok = loadEnv({ ...base, NODE_ENV: 'production', REDIS_URL: 'rediss://default:pw@redis.internal:6380' });
    expect(ok.nodeEnv).toBe('production');
    expect(invalid({ ...base, NODE_ENV: 'production', REDIS_URL: 'rediss://redis.internal:6380' }).variables).toEqual(['REDIS_URL']);
    expect(invalid({ ...base, NODE_ENV: 'production', REDIS_URL: 'rediss://user@redis.internal:6380' }).variables).toEqual(['REDIS_URL']);
  });

  it.each(['http://127.0.0.1:6379', 'redis:', 'not a url', '', 'unix:///tmp/redis.sock'])('rejects REDIS_URL %j', (url) => {
    expect(invalid({ ...base, REDIS_URL: url }).variables).toEqual(['REDIS_URL']);
  });

  it.each([
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '-1'],
    ['WORKER_CONCURRENCY', '1.5'],
    ['WORKER_HEALTH_PORT', '0'],
    ['WORKER_HEALTH_PORT', '65536'],
    ['WORKER_HEALTH_HOST', 'bad host'],
    ['WORKER_SHUTDOWN_TIMEOUT_MS', '0'],
    ['WORKER_SHUTDOWN_TIMEOUT_MS', 'soon'],
    ['LOG_LEVEL', 'verbose'],
    ['NODE_ENV', 'staging'],
  ])('rejects %s=%j', (name, value) => {
    expect(invalid({ ...base, [name]: value }).variables).toEqual([name]);
  });

  it('accepts explicit concurrency and shutdown timeout', () => {
    expect(loadEnv({ ...base, WORKER_CONCURRENCY: '12', WORKER_SHUTDOWN_TIMEOUT_MS: '1000' })).toMatchObject({
      concurrency: 12,
      shutdownTimeoutMs: 1000,
    });
  });

  it('never includes the Redis URL or password in errors', () => {
    const error = invalid({ ...base, NODE_ENV: 'production', REDIS_URL: 'redis://:very-secret-password@host:6379' });
    expect(error.message).toBe('Invalid or missing environment variables: REDIS_URL');
    expect(JSON.stringify(error)).not.toContain('very-secret-password');
  });

  it('matches the environment inventory, including its defaults', () => {
    expect(() => assertFieldsMatchInventory('worker', WORKER_ENV_FIELDS)).not.toThrow();
    const defaults = Object.fromEntries(variablesFor('worker').map((entry) => [entry.name, entry.default]));
    expect(defaults).toMatchObject({ LOG_LEVEL: 'info', WORKER_CONCURRENCY: '5', WORKER_SHUTDOWN_TIMEOUT_MS: '25000' });
  });

  it('describes the loaded configuration without values or names', () => {
    expect(workerConfigLoadedEvent()).toEqual({ event: 'config_loaded', component: 'worker', variablesValidated: 7 });
  });
});
