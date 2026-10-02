import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE, type AuthSecurityEvent } from '../src/auth/auth-security-events.service.js';
import { LOGIN_ENFORCEMENT_STORE, type LoginAttempt } from '../src/auth/login-enforcement.service.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { LOGIN_IDENTITY_STORE, SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { InvalidCredentialsError, AuthProviderUnavailableError } from '../src/auth/auth-errors.js';
import type { SupabaseSession } from '../src/auth/supabase-auth.client.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `POST /v1/auth/login`, at the API boundary.
 *
 * The interesting assertions are not "does a correct password work" — they are the ones about what a
 * caller can *learn*. A wrong password, an identifier that was never registered and a locked account
 * must be indistinguishable in status, code, body and, as far as this layer controls it, in the work
 * done: the provider is called in all three cases where credentials could be tested at all.
 *
 * The doubles below stand in for the three things that reach outside the process — the database, Redis
 * and Supabase. Everything between them is the real application: the real guard, the real pipe, the
 * real service and the real problem-details filter.
 */

const IDENTIFIER = 'person@example.test';
const PASSWORD = 'correct horse battery';
const KNOWN_USER = '11111111-1111-4111-8111-111111111111';

const SESSION: SupabaseSession = {
  userId: KNOWN_USER,
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresIn: 3600,
};

interface Recorded {
  readonly attempts: LoginAttempt[];
  readonly events: AuthSecurityEvent[];
  readonly calls: string[];
}

interface Doubles {
  /** Resolves the identifier; undefined means "no account". */
  readonly userId?: string | null;
  readonly locked?: boolean;
  /** Allowed by the throttle. Default true. */
  readonly allowed?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
  readonly signIn?: () => Promise<SupabaseSession>;
  /**
   * Whether the account has confirmed a contact (Phase 7-A). Default true, so every assertion written
   * before 7-A still describes the same account it always described.
   */
  readonly contactConfirmed?: boolean;
  /** The 0065 read is unavailable. It must deny, never allow.  */
  readonly contactThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles): Promise<Recorded> {
  const recorded: Recorded = { attempts: [], events: [], calls: [] };
  const allowed = doubles.allowed ?? true;

  const counter = (label: string, throws: boolean) => ({
    hit: async (): Promise<boolean> => {
      recorded.calls.push(label);
      if (throws) throw new Error(`${label} unavailable`);
      return allowed;
    },
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(counter('redis', doubles.redisThrows ?? false))
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(counter('durable', doubles.durableThrows ?? false))
    .overrideProvider(LOGIN_IDENTITY_STORE)
    .useValue({
      userIdForLoginIdentifier: async (): Promise<string | null> => {
        recorded.calls.push('resolve');
        return doubles.userId ?? null;
      },
      loginContactConfirmed: async (): Promise<boolean> => {
        recorded.calls.push('contact-confirmed');
        if (doubles.contactThrows === true) throw new Error('contact state unavailable');
        return doubles.contactConfirmed ?? true;
      },
    })
    .overrideProvider(LOGIN_ENFORCEMENT_STORE)
    .useValue({
      isAccountLocked: async (): Promise<boolean> => {
        recorded.calls.push('lockout');
        return doubles.locked ?? false;
      },
      recordLoginAttempt: async (attempt: LoginAttempt): Promise<boolean> => {
        recorded.calls.push('record-attempt');
        recorded.attempts.push(attempt);
        return false;
      },
    })
    .overrideProvider(AUTH_SECURITY_EVENT_STORE)
    .useValue({
      recordAuthSecurityEvent: async (event: AuthSecurityEvent): Promise<void> => {
        recorded.events.push(event);
      },
    })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      signInWithPassword: async (): Promise<SupabaseSession> => {
        recorded.calls.push('provider');
        if (doubles.signIn !== undefined) return doubles.signIn();
        return SESSION;
      },
      signOut: async (): Promise<'signed_out' | 'already_invalid'> => {
        recorded.calls.push('sign-out');
        return 'signed_out';
      },
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

/** `null` means "send no credential at all"; `undefined` is not used, because a default would absorb it. */
async function login(payload: unknown, credential: string | null = TEST_INTERNAL_CREDENTIAL): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: {
      'content-type': 'application/json',
      ...(credential === null ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential }),
    },
    payload: JSON.stringify(payload),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    headers: response.headers as Record<string, unknown>,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /v1/auth/login', () => {
  it('signs in with valid credentials and returns the session for the BFF, not a bearer token', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    // The session crosses exactly one server-to-server hop. It is in `session`, never at the top level
    // as a bearer token, and the BFF is the only thing that reads it.
    expect(result.body['session']).toEqual({
      accessToken: SESSION.accessToken,
      refreshToken: SESSION.refreshToken,
      expiresIn: SESSION.expiresIn,
    });
    expect(result.headers['www-authenticate']).toBeUndefined();

    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.attempts[0]).toMatchObject({ userId: KNOWN_USER, succeeded: true, failureReason: null });
    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.login.success']);
  });

  it('rejects wrong credentials with the generic problem and records the attempt', async () => {
    const recorded = await start({
      userId: KNOWN_USER,
      signIn: () => Promise.reject(new InvalidCredentialsError()),
    });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(result.body['detail']).toBe('Authentication failed.');
    expect(result.headers['www-authenticate']).toBeUndefined();

    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.attempts[0]).toMatchObject({ succeeded: false, failureReason: 'invalid_credentials' });
    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.login.failure']);
  });

  it('answers an unknown identifier exactly as it answers a wrong password', async () => {
    const wrongPassword = await start({
      userId: KNOWN_USER,
      signIn: () => Promise.reject(new InvalidCredentialsError()),
    });
    const known = await login({ identifier: IDENTIFIER, password: PASSWORD });
    await app?.close();
    app = undefined;

    const unknown = await start({ userId: null, signIn: () => Promise.reject(new InvalidCredentialsError()) });
    const stranger = await login({ identifier: 'nobody@example.test', password: PASSWORD });

    // Same status, same code, same detail, same absence of anything else: no enumeration.
    expect(stranger.status).toBe(known.status);
    expect(stranger.body).toEqual({ ...known.body, instance: known.body['instance'] });
    // And the provider was called for the stranger too, so the two do not differ in work done either.
    expect(unknown.calls).toContain('provider');
    expect(wrongPassword.calls).toContain('provider');
  });

  it('answers a locked account exactly as it answers a wrong password, and never calls the provider', async () => {
    const recorded = await start({ userId: KNOWN_USER, locked: true });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(result.body['detail']).toBe('Authentication failed.');

    // AUTH-3 / N1: the lockout decision happens before Supabase is contacted.
    expect(recorded.calls).toContain('lockout');
    expect(recorded.calls).not.toContain('provider');
    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.login.locked']);
    // A lockout rejection is not a credential test, so it must not feed the 0034 lockout counter.
    expect(recorded.attempts).toHaveLength(0);
  });

  it('checks the throttle and the lockout before the provider, in that order', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    const order = recorded.calls;
    expect(order.indexOf('redis')).toBeLessThan(order.indexOf('resolve'));
    expect(order.indexOf('resolve')).toBeLessThan(order.indexOf('lockout'));
    expect(order.indexOf('lockout')).toBeLessThan(order.indexOf('provider'));
    expect(order.indexOf('provider')).toBeLessThan(order.indexOf('record-attempt'));
  });

  it('rejects a throttled request with 429 before touching the account or the provider', async () => {
    const recorded = await start({ userId: KNOWN_USER, allowed: false });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(429);
    expect(result.body['code']).toBe('TOO_MANY_REQUESTS');
    expect(recorded.calls).not.toContain('provider');
    expect(recorded.calls).not.toContain('lockout');
    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.login.throttled']);
    // C-1 keeps the lockout separate: a flood must not be able to lock someone else's account.
    expect(recorded.attempts).toHaveLength(0);
  });

  it('answers 503 when the provider is unavailable, and never calls it a wrong password', async () => {
    const recorded = await start({
      userId: KNOWN_USER,
      signIn: () => Promise.reject(new AuthProviderUnavailableError(new Error('boom'))),
    });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.login.provider_error']);
    // An outage must not consume a user's five attempts.
    expect(recorded.attempts).toHaveLength(0);
  });

  it('answers 503 when neither throttle counter can answer, rather than allowing the request', async () => {
    const recorded = await start({ userId: KNOWN_USER, redisThrows: true, durableThrows: true });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(recorded.calls).not.toContain('provider');
  });

  it('falls back to the durable counter when Redis is unavailable', async () => {
    const recorded = await start({ userId: KNOWN_USER, redisThrows: true });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(recorded.calls).toContain('durable');
  });

  it('rejects a password the policy forbids before the provider is called', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    const result = await login({ identifier: IDENTIFIER, password: 'short' });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).not.toContain('provider');
    expect(recorded.calls).not.toContain('redis');
  });

  it('rejects a malformed body with 400 and no authentication work', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    const result = await login({ identifier: '', password: PASSWORD });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).toEqual([]);
  });

  it('still requires the internal BFF credential', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    const missing = await login({ identifier: IDENTIFIER, password: PASSWORD }, null);
    const wrong = await login({ identifier: IDENTIFIER, password: PASSWORD }, 'wrong-credential-value');

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    // The guard runs before anything else: no counter moved, no account was looked up.
    expect(recorded.calls).toEqual([]);
  });

  it('records only hashes in the security event, never the identifier itself', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    const [event] = recorded.events;
    expect(event).toBeDefined();
    expect(Buffer.isBuffer(event!.identifierHash)).toBe(true);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(IDENTIFIER);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(SESSION.accessToken);
    expect(serialized).not.toContain(SESSION.refreshToken);
  });

  it('never writes the password or a token into the durable attempt record', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    const serialized = JSON.stringify(recorded.attempts);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(IDENTIFIER);
    expect(serialized).not.toContain(SESSION.accessToken);
  });
});

/**
 * VERIFY FIRST at the login boundary (Phase 7-A).
 *
 * The approved decision is that a newly registered account verifies its contact **before** its first
 * sign-in, and this is the one change Phase 7-A makes to the completed Phase 3 login surface. The
 * assertions that matter are not "is it refused" — they are that being refused for this reason is
 * indistinguishable from any other refusal, and that the refusal happens at all when the read behind it
 * cannot answer.
 */
describe('POST /v1/auth/login — the contact gate', () => {
  it('refuses an account that has confirmed no contact, even with the right password', async () => {
    await start({ userId: KNOWN_USER, contactConfirmed: false });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    // No session reaches the caller, in any field, under any name.
    expect(Object.keys(result.body)).not.toContain('session');
    expect(JSON.stringify(result.body)).not.toContain(SESSION.accessToken);
    expect(JSON.stringify(result.body)).not.toContain(SESSION.refreshToken);
  });

  it('is indistinguishable from a wrong password', async () => {
    await start({ userId: KNOWN_USER, contactConfirmed: false });
    const unverified = await login({ identifier: IDENTIFIER, password: PASSWORD });
    await app?.close();
    app = undefined;

    await start({
      userId: KNOWN_USER,
      signIn: () => Promise.reject(new InvalidCredentialsError()),
    });
    const wrongPassword = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(unverified.status).toBe(wrongPassword.status);
    expect(unverified.body).toEqual(wrongPassword.body);
  });

  it('asks only after the provider has answered, so an unverified account costs the same work', async () => {
    const recorded = await start({ userId: KNOWN_USER, contactConfirmed: false });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    // The gate cannot be reached without the provider having been called first. Were it the other way
    // round, a registered-but-unverified address would answer faster than an address that does not
    // exist, and any wrong password would reveal which was which.
    expect(recorded.calls.indexOf('provider')).toBeGreaterThan(-1);
    expect(recorded.calls.indexOf('contact-confirmed')).toBeGreaterThan(
      recorded.calls.indexOf('provider'),
    );
  });

  it('revokes the session the provider created on its way to refusing the sign-in', async () => {
    const recorded = await start({ userId: KNOWN_USER, contactConfirmed: false });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(recorded.calls).toContain('sign-out');
  });

  it('records the correct password as a successful attempt, so waiting to verify cannot lock the account', async () => {
    const recorded = await start({ userId: KNOWN_USER, contactConfirmed: false });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    // 0034 counts credential tests, and this credential test passed. Writing it as a failure would let a
    // person whose password is perfectly correct lock themselves out while their code is in flight.
    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.attempts[0]!.succeeded).toBe(true);
  });

  it('records the refusal as a login failure with its own reason code, and no login success', async () => {
    const recorded = await start({ userId: KNOWN_USER, contactConfirmed: false });
    await login({ identifier: IDENTIFIER, password: PASSWORD });

    const types = recorded.events.map((event) => event.eventType);
    expect(types).toContain('auth.login.failure');
    expect(types).not.toContain('auth.login.success');
    const failure = recorded.events.find((event) => event.eventType === 'auth.login.failure');
    expect(failure!.reasonCode).toBe('contact_unverified');
    // Phase 7-A adds no eighth C-20 event type: the refusal is recorded with an approved type and a new
    // reason code, which is what the reason-code field is for.
    expect(types.every((type) => type.startsWith('auth.login.'))).toBe(true);
  });

  it('denies the sign-in when the contact state cannot be read, and never allows it', async () => {
    const recorded = await start({ userId: KNOWN_USER, contactThrows: true });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    // An auth control that cannot answer refuses. The status is the one an unreachable lockout store
    // already produces, so an outage does not masquerade as a wrong password.
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(Object.keys(result.body)).not.toContain('session');
    expect(recorded.calls).toContain('contact-confirmed');
  });

  it('leaves a confirmed account exactly as it was before Phase 7-A', async () => {
    const recorded = await start({ userId: KNOWN_USER });
    const result = await login({ identifier: IDENTIFIER, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['session', 'status']);
    expect(recorded.calls).not.toContain('sign-out');
    expect(recorded.events.map((event) => event.eventType)).toContain('auth.login.success');
  });
});
