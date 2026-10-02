import { describe, expect, it } from 'vitest';
import { assertFieldsMatchInventory, variablesFor } from '@repo/server-config';
import { DEFAULT_CONCURRENCY, DEFAULT_DATABASE_MAX_CONNECTIONS, DEFAULT_EMAIL_RELAY_INTERVAL_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS, EnvValidationError, loadEnv, WORKER_ENV_FIELDS, workerConfigLoadedEvent } from '../src/config/env.js';

const base = {
  NODE_ENV: 'development',
  PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
  APP_WORKER_DATABASE_URL: 'postgres://app_worker@127.0.0.1:5432/marketplace_test',
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

  it('requires NODE_ENV, APP_WORKER_DATABASE_URL, REDIS_URL, WORKER_HEALTH_HOST and WORKER_HEALTH_PORT', () => {
    expect(invalid({}).variables).toEqual(['APP_WORKER_DATABASE_URL', 'NODE_ENV', 'PSEUDONYMOUS_USER_ID_KEY', 'REDIS_URL', 'WORKER_HEALTH_HOST', 'WORKER_HEALTH_PORT']);
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
    // Phase 7-D.
    ['APP_WORKER_DATABASE_URL', 'mysql://host/db'],
    ['APP_WORKER_DATABASE_URL', 'postgres://with a space'],
    ['APP_WORKER_DATABASE_URL', ''],
    ['APP_WORKER_DATABASE_MAX_CONNECTIONS', '0'],
    ['APP_WORKER_DATABASE_MAX_CONNECTIONS', '501'],
    ['EMAIL_RELAY_INTERVAL_MS', '999'],
    ['EMAIL_RELAY_INTERVAL_MS', '3600001'],
    ['EMAIL_RELAY_INTERVAL_MS', 'often'],
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
    expect(defaults).toMatchObject({
      LOG_LEVEL: 'info',
      WORKER_CONCURRENCY: '5',
      WORKER_SHUTDOWN_TIMEOUT_MS: '25000',
      APP_WORKER_DATABASE_MAX_CONNECTIONS: '10',
      EMAIL_RELAY_INTERVAL_MS: '15000',
    });
    // 7-D introduces no provider credential of any kind: there is no adapter yet to hold one.
    const workerNames = variablesFor('worker').map((entry) => entry.name);
    for (const forbidden of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_API_KEY', 'EMAIL_PROVIDER_API_KEY', 'MAIL_API_KEY']) {
      expect(workerNames).not.toContain(forbidden);
    }
  });

  it('carries the Phase 7-D relay settings with their inventory defaults', () => {
    expect(loadEnv(base)).toMatchObject({
      appWorkerDatabaseUrl: 'postgres://app_worker@127.0.0.1:5432/marketplace_test',
      appWorkerDatabaseMaxConnections: DEFAULT_DATABASE_MAX_CONNECTIONS,
      emailRelayIntervalMs: DEFAULT_EMAIL_RELAY_INTERVAL_MS,
    });
    expect(DEFAULT_DATABASE_MAX_CONNECTIONS).toBe(10);
    expect(DEFAULT_EMAIL_RELAY_INTERVAL_MS).toBe(15_000);
    expect(loadEnv({ ...base, EMAIL_RELAY_INTERVAL_MS: '60000', APP_WORKER_DATABASE_MAX_CONNECTIONS: '4' })).toMatchObject({
      emailRelayIntervalMs: 60_000,
      appWorkerDatabaseMaxConnections: 4,
    });
  });

  it('never includes the app_worker connection string in errors', () => {
    const error = invalid({ ...base, APP_WORKER_DATABASE_URL: 'postgres://app_worker:very-secret-db-password@host:5432/db with a space' });
    expect(error.message).toBe('Invalid or missing environment variables: APP_WORKER_DATABASE_URL');
    expect(JSON.stringify(error)).not.toContain('very-secret-db-password');
  });

  it('describes the loaded configuration without values or names', () => {
    expect(workerConfigLoadedEvent()).toEqual({ event: 'config_loaded', component: 'worker', variablesValidated: 13 });
  });
});
