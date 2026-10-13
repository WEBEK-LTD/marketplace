import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { REDIS_THROTTLE_COUNTER, DURABLE_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { LISTING_EVENT_STREAM_PORT } from '../src/analytics/listing-events.stream.js';
import { loadEnv } from '../src/config/env.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The API with no Redis configured at all (increment 0117).
 *
 * **Why this suite exists.** The owner's deployment is Netlify and Supabase and nothing else, which means
 * there is no Redis to point at. That is not a degraded deployment and these assertions are what makes the
 * difference between the two statements:
 *
 *   * the application **starts**, rather than refusing a configuration that is now ordinary;
 *   * the login throttle's first tier is **absent rather than broken** — nothing is constructed, so nothing
 *     times out on every login and nothing logs a warning each time;
 *   * the C-1 limits are still **enforced**, by the durable PostgreSQL counter that a Redis outage has
 *     always fallen through to — same buckets, same windows, same numbers;
 *   * the never-fail-open rule is **untouched**: a request that cannot be counted at all is still refused.
 *
 * The last two are owner decision C-1, and this is the deployment where they stop having a cache in front
 * of them. Losing the cache is acceptable; losing the limit would not be.
 */

/** `TEST_ENV` with the Redis URL taken away, which is what the deployment actually looks like. */
const SOURCE = Object.freeze({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  LOG_LEVEL: 'info',
  APP_SYSTEM_DATABASE_URL: 'postgresql://app_system@db.invalid:5432/marketplace',
  DEVICE_IDENTITY_KEY: 'test-device-identity-key-not-a-real-secret-0123',
  ANALYTICS_SESSION_KEY: 'test-analytics-session-key-not-a-real-secret-01',
  OTP_PEPPER: 'test-otp-pepper-value-not-a-real-secret-0123456789',
  PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
  WAABEK_BASE_URL: 'https://waabek.invalid',
  WAABEK_API_KEY: 'test-waabek-key-not-a-real-secret',
  INTERNAL_BFF_CREDENTIAL: TEST_INTERNAL_CREDENTIAL,
  SUPABASE_URL: 'https://supabase.invalid',
  SUPABASE_SECRET_KEY: 'test-supabase-secret-not-a-real-key',
  WEB_PUBLIC_ORIGIN: 'https://web.invalid',
});

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('the configuration', () => {
  it('starts with no REDIS_URL, and reports it as absent rather than empty', () => {
    const env = loadEnv(SOURCE);
    expect(env.redisUrl).toBeNull();
    // Everything else is still required, so this is one variable becoming optional and not a loosening.
    expect(() => loadEnv({ ...SOURCE, SUPABASE_URL: undefined })).toThrow(
      'Invalid or missing environment variables: SUPABASE_URL',
    );
  });

  it('still refuses a present-but-empty value, like every other optional variable here', () => {
    // Only an unset variable counts as absent. An empty field is a value that fails its validator, which is
    // the rule that keeps a half-configured deployment from looking like a deliberate one.
    expect(() => loadEnv({ ...SOURCE, REDIS_URL: '' })).toThrow(
      'Invalid or missing environment variables: REDIS_URL',
    );
  });

  it('carries a URL through when one is configured, so the first tier is still available', () => {
    expect(loadEnv({ ...SOURCE, REDIS_URL: 'rediss://user:pass@redis.invalid:6379' }).redisUrl).toBe(
      'rediss://user:pass@redis.invalid:6379',
    );
  });
});

describe('the application, with no Redis', () => {
  it('boots and serves, and builds no Redis-backed provider at all', async () => {
    const env = loadEnv(SOURCE);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(env, { logStream: { write: () => undefined } }),
      NEST_APP_OPTIONS,
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Absent, not broken: nothing was constructed, so nothing can time out or warn on every login.
    expect(moduleRef.get(REDIS_THROTTLE_COUNTER, { strict: false })).toBeNull();
    expect(moduleRef.get(LISTING_EVENT_STREAM_PORT, { strict: false })).toBeNull();
    // And the tier that does the enforcing is still there.
    expect(moduleRef.get(DURABLE_THROTTLE_COUNTER, { strict: false })).not.toBeNull();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('still refuses a request with no internal credential', async () => {
    // The thing a serverless deployment makes publicly reachable, asserted in the configuration that
    // deployment actually runs: the guard is the boundary, and it does not depend on Redis.
    const env = loadEnv(SOURCE);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(env, { logStream: { write: () => undefined } }),
      NEST_APP_OPTIONS,
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect((await app.inject({ method: 'GET', url: '/v1/listings' })).statusCode).toBe(403);
    // And with it, the request reaches the application proper — here a 503, because `db.invalid` is not a
    // database. What matters is that it got past the guard rather than being refused for want of Redis.
    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/listings',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    expect(allowed.statusCode).toBe(503);
  });
});
