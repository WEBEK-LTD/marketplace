import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE, type AuthSecurityEvent } from '../src/auth/auth-security-events.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { OTP_CHALLENGE_STORE } from '../src/auth/otp/otp.service.js';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';
import { REGISTRATION_STORE } from '../src/auth/registration.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Registration and contact verification at the API boundary (Phase 7-A).
 *
 * The interesting assertions are not "does registering work". They are the two promises the approved
 * decisions make, and both are about what a caller can *learn* or *obtain*:
 *
 *   * **Nothing discloses that an address is already registered.** A taken email and a free one must be
 *     identical in status, in body shape, in the fields present and in the shape of the challenge
 *     identifier — and the person who really owns that address must not be messaged.
 *   * **No session is created.** Not by registering, and not by verifying. VERIFY FIRST means the account
 *     goes to the login flow afterwards, so neither route may return a token, set a cookie, or ask the
 *     provider for a session.
 *
 * The doubles stand in for the three things that reach outside the process — the database, Supabase and
 * Waabek. Everything between them is the real application: the real guard, the real pipe, the real
 * service and the real problem-details filter.
 */

const EMAIL = 'new.person@example.test';
const PHONE = '+201555000222';
const PASSWORD = 'a-sufficiently-long-password';
const NEW_USER = '11111111-1111-4111-8111-111111111111';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const CODE = '123456';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Recorded {
  readonly calls: string[];
  readonly events: AuthSecurityEvent[];
  readonly created: Array<Record<string, unknown>>;
  readonly issued: Array<Record<string, unknown>>;
  readonly sent: Array<{ to: string; message: string }>;
  readonly verified: Array<Record<string, unknown>>;
  readonly confirmed: string[];
  readonly resendsResolved: string[];
}

interface Doubles {
  /** `null` is the provider's answer for an address that already belongs to an account. */
  readonly createdUserId?: string | null;
  readonly createThrows?: boolean;
  readonly issueOutcome?: 'issued' | 'cooldown' | 'rate_limited_destination_hour';
  readonly deliver?: 'sent' | 'failed';
  readonly verifyOutcome?: string;
  readonly verifiedUserId?: string | null;
  readonly verifyThrows?: boolean;
  readonly confirmThrows?: boolean;
  readonly resendOutcome?: string;
  readonly resendPhone?: string | null;
  readonly resendThrows?: boolean;
  /** The C-20 writer is unavailable. It must not cost the person their registration. */
  readonly eventThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    calls: [],
    events: [],
    created: [],
    issued: [],
    sent: [],
    verified: [],
    confirmed: [],
    resendsResolved: [],
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      createUnconfirmedUser: async (input: Record<string, unknown>) => {
        recorded.calls.push('create-user');
        recorded.created.push(input);
        if (doubles.createThrows === true) throw new Error('provider unavailable');
        return doubles.createdUserId === undefined ? NEW_USER : doubles.createdUserId;
      },
      confirmPhone: async (userId: string) => {
        recorded.calls.push('confirm-phone');
        if (doubles.confirmThrows === true) throw new Error('provider unavailable');
        recorded.confirmed.push(userId);
      },
      // Any of these being reached at all is a failure of the design, not of a number.
      signInWithPassword: async () => {
        throw new Error('registration must never sign anyone in');
      },
      refreshSession: async () => {
        throw new Error('registration must never create a session');
      },
      updatePassword: async () => {
        throw new Error('registration must never change a password');
      },
      updatePhone: async () => {
        throw new Error('registration must never replace an account’s number');
      },
    })
    .overrideProvider(OTP_CHALLENGE_STORE)
    .useValue({
      issueOtpChallenge: async (input: Record<string, unknown>) => {
        recorded.calls.push('issue-otp');
        recorded.issued.push(input);
        const outcome = doubles.issueOutcome ?? 'issued';
        return outcome === 'issued'
          ? {
              outcome,
              challengeId: CHALLENGE,
              outboxId: 'cccccccc-0000-4000-8000-000000000001',
              sendCount: 1,
              retryAfterSeconds: null,
              expiresAt: new Date(Date.now() + 600_000),
            }
          : {
              outcome,
              challengeId: null,
              outboxId: null,
              sendCount: null,
              retryAfterSeconds: 60,
              expiresAt: null,
            };
      },
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
      verifyOtpChallenge: async () => {
        throw new Error('registration verifies through its own function, not this one');
      },
    })
    .overrideProvider(REGISTRATION_STORE)
    .useValue({
      registerResendContact: async (challengeId: string) => {
        recorded.calls.push('resolve-resend');
        recorded.resendsResolved.push(challengeId);
        if (doubles.resendThrows === true) throw new Error('database unavailable');
        const outcome = doubles.resendOutcome ?? 'resend';
        return outcome === 'resend'
          ? {
              outcome,
              userId: NEW_USER,
              toPhoneE164: doubles.resendPhone === undefined ? PHONE : doubles.resendPhone,
            }
          : { outcome, userId: null, toPhoneE164: null };
      },
      registerVerifyContact: async (input: Record<string, unknown>) => {
        recorded.calls.push('verify-contact');
        recorded.verified.push(input);
        if (doubles.verifyThrows === true) throw new Error('database unavailable');
        const outcome = doubles.verifyOutcome ?? 'verified';
        return {
          outcome,
          userId:
            outcome === 'verified' ? (doubles.verifiedUserId === undefined ? NEW_USER : doubles.verifiedUserId) : null,
        };
      },
    })
    .overrideProvider(WaabekClient)
    .useValue({
      send: async (to: string, message: string) => {
        recorded.calls.push('waabek');
        recorded.sent.push({ to, message });
        return doubles.deliver === 'failed'
          ? { status: 'failed', errorType: 'provider_error' }
          : { status: 'sent', providerMessageId: 'provider-message-id' };
      },
    })
    .overrideProvider(AUTH_SECURITY_EVENT_STORE)
    .useValue({
      recordAuthSecurityEvent: async (event: AuthSecurityEvent): Promise<void> => {
        if (doubles.eventThrows === true) throw new Error('security event store unavailable');
        recorded.events.push(event);
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
  readonly raw: string;
}

async function post(
  step: 'register' | 'register/resend' | 'register/verify',
  payload: unknown,
  credential: string | null = TEST_INTERNAL_CREDENTIAL,
  extraHeaders: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: `/v1/auth/${step}`,
    headers: {
      'content-type': 'application/json',
      ...(credential === null ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential }),
      ...extraHeaders,
    },
    payload: JSON.stringify(payload),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    headers: response.headers as Record<string, unknown>,
    raw: response.body,
  };
}

const REGISTRATION = { email: EMAIL, phone: PHONE, password: PASSWORD, displayName: 'Nadia' };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /v1/auth/register', () => {
  it('creates an account with no confirmed contact and sends the code to the phone', async () => {
    const recorded = await start();
    const result = await post('register', REGISTRATION);

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['challengeId', 'status']);
    expect(result.body['status']).toBe('ok');
    expect(result.body['challengeId']).toBe(CHALLENGE);
    expect(recorded.created).toHaveLength(1);
    expect(recorded.sent[0]!.to).toBe(PHONE);
  });

  it('reuses the established OTP purpose rather than inventing a second mechanism', async () => {
    const recorded = await start();
    await post('register', REGISTRATION);

    const issued = recorded.issued[0]!;
    expect(issued['purpose']).toBe('phone_verify');
    expect(issued['channel']).toBe('whatsapp');
    // The challenge belongs to the account from the start, which is what lets verification confirm it.
    expect(issued['userId']).toBe(NEW_USER);
    // The send limits live in `issue_otp_challenge`, so the request must go through it, not around it.
    expect(recorded.calls.indexOf('issue-otp')).toBeLessThan(recorded.calls.indexOf('waabek'));
  });

  it('carries the optional name to the provider as the profile trigger’s own metadata key', async () => {
    const recorded = await start();
    await post('register', REGISTRATION);

    // 0005's `on_auth_user_created` trigger reads `user_metadata.display_name` when it creates the
    // profile row, so 7-A supplies that key and writes to no table itself.
    expect(recorded.created[0]!['displayName']).toBe('Nadia');
  });

  it('omits the name entirely when it was not given', async () => {
    const recorded = await start();
    const { displayName: _unused, ...withoutName } = REGISTRATION;
    await post('register', withoutName);

    expect(recorded.created[0]!['displayName']).toBeUndefined();
  });

  it('answers a taken address exactly as it answers a free one', async () => {
    await start();
    const free = await post('register', REGISTRATION);
    await app?.close();
    app = undefined;

    const recorded = await start({ createdUserId: null });
    const taken = await post('register', REGISTRATION);

    expect(taken.status).toBe(free.status);
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(free.body).sort());
    expect(taken.body['status']).toBe(free.body['status']);
    expect(taken.body['challengeId']).toMatch(UUID);
    // The identifier is of the same shape, and belongs to nothing.
    expect(taken.body['challengeId']).not.toBe(CHALLENGE);
    expect(recorded.verified).toHaveLength(0);
  });

  it('never messages the number when the address is already taken', async () => {
    const recorded = await start({ createdUserId: null });
    await post('register', REGISTRATION);

    // Sending here would deliver a code to a number the requester may not hold, and would tell the real
    // owner of that account that someone tried to register it.
    expect(recorded.sent).toHaveLength(0);
    expect(recorded.calls).not.toContain('issue-otp');
  });

  it('never returns a session, a token or an account identifier', async () => {
    await start();
    const result = await post('register', REGISTRATION);

    expect(result.raw).not.toContain(NEW_USER);
    expect(result.raw).not.toContain(PASSWORD);
    expect(result.raw).not.toContain(EMAIL);
    expect(result.raw).not.toContain(PHONE);
    for (const field of ['session', 'accessToken', 'refreshToken', 'token', 'userId']) {
      expect(Object.keys(result.body)).not.toContain(field);
    }
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('never puts the code in the response, the headers or the outbox row', async () => {
    const recorded = await start();
    const result = await post('register', REGISTRATION);

    const code = recorded.sent[0]!.message.match(/\b[0-9]{6}\b/)![0];
    expect(result.raw).not.toContain(code);
    expect(JSON.stringify(result.headers)).not.toContain(code);
    // The challenge row carries a digest, never the code.
    expect(JSON.stringify(recorded.issued)).not.toContain(code);
    expect(Buffer.isBuffer(recorded.issued[0]!['codeHash'])).toBe(true);
  });

  it('renders the approved OTP limits as one 429, whether a cooldown or a rate limit', async () => {
    await start({ issueOutcome: 'cooldown' });
    const cooldown = await post('register', REGISTRATION);
    await app?.close();
    app = undefined;

    await start({ issueOutcome: 'rate_limited_destination_hour' });
    const limited = await post('register', REGISTRATION);

    expect(cooldown.status).toBe(429);
    expect(limited.status).toBe(429);
    expect(cooldown.body['code']).toBe('TOO_MANY_REQUESTS');
    expect(limited.body['code']).toBe('TOO_MANY_REQUESTS');
    // Neither says which limit, which number, or how many sends are left.
    expect(cooldown.raw).not.toContain(PHONE);
    expect(limited.raw).not.toContain('destination');
  });

  it('is a 503 when the account could not be created or the code not delivered', async () => {
    await start({ createThrows: true });
    const created = await post('register', REGISTRATION);
    await app?.close();
    app = undefined;

    await start({ deliver: 'failed' });
    const delivered = await post('register', REGISTRATION);

    expect(created.status).toBe(503);
    expect(delivered.status).toBe(503);
    expect(created.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(delivered.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('validates before doing any work at all', async () => {
    for (const payload of [
      { ...REGISTRATION, email: 'not-an-email' },
      { ...REGISTRATION, phone: '01000000001' },
      { ...REGISTRATION, password: 'short' },
      { ...REGISTRATION, userId: NEW_USER },
      {},
    ]) {
      const recorded = await start();
      const result = await post('register', payload);
      expect(result.status, JSON.stringify(payload)).toBe(400);
      expect(result.body['code']).toBe('VALIDATION_FAILED');
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('still requires the internal BFF credential', async () => {
    const recorded = await start();
    const missing = await post('register', REGISTRATION, null);
    const wrong = await post('register', REGISTRATION, 'wrong-credential-value');

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('POST /v1/auth/register/verify', () => {
  const VERIFY = { challengeId: CHALLENGE, otp: CODE };

  it('confirms the account’s contact when the code is right', async () => {
    const recorded = await start();
    const result = await post('register/verify', VERIFY);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'verified' });
    expect(recorded.confirmed).toEqual([NEW_USER]);
  });

  it('verifies through its own function, with a digest and no account named by the request', async () => {
    const recorded = await start();
    await post('register/verify', VERIFY);

    const verified = recorded.verified[0]!;
    expect(verified['challengeId']).toBe(CHALLENGE);
    expect(Buffer.isBuffer(verified['codeHash'])).toBe(true);
    // Nothing in the request says whose account this is: the challenge decides.
    expect(Object.keys(verified).sort()).toEqual(['challengeId', 'codeHash']);
    expect(JSON.stringify(verified)).not.toContain(CODE);
  });

  it('refuses every unsuccessful outcome identically', async () => {
    const answers: Result[] = [];
    for (const verifyOutcome of ['invalid', 'expired', 'consumed', 'too_many_attempts', 'not_found']) {
      await start({ verifyOutcome });
      answers.push(await post('register/verify', VERIFY));
      await app?.close();
      app = undefined;
    }
    await start();

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body['code']).toBe('AUTHENTICATION_FAILED');
      expect(answer.body).toEqual(answers[0]!.body);
    }
  });

  it('refuses a verified outcome that names no account, so a challenge without one confirms nothing', async () => {
    const recorded = await start({ verifiedUserId: null });
    const result = await post('register/verify', VERIFY);

    expect(result.status).toBe(401);
    expect(recorded.confirmed).toEqual([]);
  });

  it('leaves the account unable to sign in when the provider cannot be told', async () => {
    const recorded = await start({ confirmThrows: true });
    const result = await post('register/verify', VERIFY);

    // A failure here must fail the request rather than report success: the contact is still unconfirmed,
    // so the login gate still refuses the account, which is the safe direction.
    expect(result.status).toBe(503);
    expect(recorded.confirmed).toEqual([]);
  });

  it('is a 503 when the verification itself could not be performed', async () => {
    await start({ verifyThrows: true });
    const result = await post('register/verify', VERIFY);

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns no session and sets no cookie on success', async () => {
    await start();
    const result = await post('register/verify', VERIFY);

    expect(result.raw).not.toContain(NEW_USER);
    for (const field of ['session', 'accessToken', 'refreshToken', 'token', 'userId', 'expiresAt']) {
      expect(Object.keys(result.body)).not.toContain(field);
    }
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('validates the code’s shape before any work', async () => {
    for (const payload of [
      { challengeId: CHALLENGE, otp: '12345' },
      { challengeId: CHALLENGE, otp: 'abcdef' },
      { challengeId: 'not-a-uuid', otp: CODE },
      { challengeId: CHALLENGE, otp: CODE, userId: NEW_USER },
      {},
    ]) {
      const recorded = await start();
      const result = await post('register/verify', payload);
      expect(result.status, JSON.stringify(payload)).toBe(400);
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('still requires the internal BFF credential', async () => {
    const recorded = await start();
    const missing = await post('register/verify', VERIFY, null);

    expect(missing.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('POST /v1/auth/register/resend', () => {
  const RESEND = { challengeId: CHALLENGE };

  it('sends a new code and hands back the fresh challenge', async () => {
    const recorded = await start();
    const result = await post('register/resend', RESEND);

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['challengeId', 'status']);
    expect(result.body['challengeId']).toBe(CHALLENGE);
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]!.to).toBe(PHONE);
  });

  it('sends to the number the database resolved, and takes none from the request', async () => {
    const recorded = await start({ resendPhone: '+201999888777' });
    await post('register/resend', { ...RESEND, phone: PHONE });

    // The extra field is refused outright by the strict schema, so nothing can be aimed. And when a
    // resend does happen, the destination is whatever the account holds.
    expect(recorded.calls).toEqual([]);
    await app?.close();
    app = undefined;

    const resolved = await start({ resendPhone: '+201999888777' });
    await post('register/resend', RESEND);
    expect(resolved.sent[0]!.to).toBe('+201999888777');
    expect(resolved.resendsResolved).toEqual([CHALLENGE]);
  });

  it('goes through the same OTP path, so the same limits and cooldowns apply', async () => {
    const recorded = await start();
    await post('register/resend', RESEND);

    const issued = recorded.issued[0]!;
    expect(issued['purpose']).toBe('phone_verify');
    expect(issued['userId']).toBe(NEW_USER);
    expect(recorded.calls.indexOf('issue-otp')).toBeLessThan(recorded.calls.indexOf('waabek'));
  });

  it('renders the cooldown as the same 429 a first send earns, and says nothing about the number', async () => {
    await start({ issueOutcome: 'cooldown' });
    const result = await post('register/resend', RESEND);

    expect(result.status).toBe(429);
    expect(result.body['code']).toBe('TOO_MANY_REQUESTS');
    expect(result.raw).not.toContain(PHONE);
    // No retry-after count, no sends-left, nothing that reports on the state of somebody's number.
    expect(Object.keys(result.body)).not.toContain('retryAfter');
    expect(Object.keys(result.body)).not.toContain('sendsLeft');
  });

  it('refuses a challenge that resolves nothing exactly as a wrong code is refused', async () => {
    const refusals: Result[] = [];
    for (const resendOutcome of ['not_found']) {
      await start({ resendOutcome });
      refusals.push(await post('register/resend', RESEND));
      await app?.close();
      app = undefined;
    }
    await start({ verifyOutcome: 'invalid' });
    const wrongCode = await post('register/verify', { challengeId: CHALLENGE, otp: CODE });

    for (const refusal of refusals) {
      expect(refusal.status).toBe(401);
      expect(refusal.body['code']).toBe('AUTHENTICATION_FAILED');
      expect(refusal.body['detail']).toBe(wrongCode.body['detail']);
    }
  });

  it('sends nothing when the challenge resolves nothing', async () => {
    const recorded = await start({ resendOutcome: 'not_found' });
    await post('register/resend', RESEND);

    expect(recorded.sent).toHaveLength(0);
    expect(recorded.calls).not.toContain('issue-otp');
  });

  it('is a 503 when the challenge could not be resolved at all', async () => {
    await start({ resendThrows: true });
    const result = await post('register/resend', RESEND);

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('creates no account and no session', async () => {
    const recorded = await start();
    const result = await post('register/resend', RESEND);

    expect(recorded.created).toHaveLength(0);
    expect(recorded.confirmed).toEqual([]);
    expect(result.headers['set-cookie']).toBeUndefined();
    for (const field of ['session', 'accessToken', 'refreshToken', 'token', 'userId']) {
      expect(Object.keys(result.body)).not.toContain(field);
    }
    expect(result.raw).not.toContain(NEW_USER);
    expect(result.raw).not.toContain(PHONE);
  });

  it('validates and still requires the internal BFF credential', async () => {
    const recorded = await start();
    const malformed = await post('register/resend', { challengeId: 'not-a-uuid' });
    const missing = await post('register/resend', RESEND, null);

    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });

  it('never puts the new code anywhere the caller can see it', async () => {
    const recorded = await start();
    const result = await post('register/resend', RESEND);

    const code = recorded.sent[0]!.message.match(/\b[0-9]{6}\b/)![0];
    expect(result.raw).not.toContain(code);
    expect(JSON.stringify(result.headers)).not.toContain(code);
    expect(JSON.stringify(recorded.issued)).not.toContain(code);
  });
});

describe('the registration security event (C-20)', () => {
  it('writes exactly one event, of the approved type, for an account that was created', async () => {
    const recorded = await start();
    await post('register', REGISTRATION);

    expect(recorded.events).toHaveLength(1);
    const [event] = recorded.events;
    // The eighth approved C-20 type, following the auth.<flow>.<outcome> convention of the other seven.
    expect(event!.eventType).toBe('auth.registration.success');
    expect(event!.reasonCode).toBe('registration_created');
    expect(event!.userId).toBe(NEW_USER);
  });

  it('writes nothing for an address that is already taken', async () => {
    const recorded = await start({ createdUserId: null });
    await post('register', REGISTRATION);

    // This is the assertion that keeps the event from becoming an oracle. A row that existed for a
    // refused registration and not for an accepted one would answer, to anyone who can read the store,
    // the question every response in this flow answers identically.
    expect(recorded.events).toEqual([]);
  });

  it('writes nothing for a submission that never created an account', async () => {
    for (const payload of [
      { ...REGISTRATION, email: 'not-an-email' },
      { ...REGISTRATION, password: 'short' },
      {},
    ]) {
      const recorded = await start();
      await post('register', payload);
      expect(recorded.events, JSON.stringify(payload)).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('writes nothing when the provider or the delivery failed', async () => {
    for (const doubles of [{ createThrows: true }, { deliver: 'failed' as const }]) {
      const recorded = await start(doubles);
      await post('register', REGISTRATION);
      // The event records a registration that got as far as a code being sent. Neither of these did.
      expect(recorded.events, JSON.stringify(doubles)).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('writes nothing when the send was refused by the approved limits', async () => {
    const recorded = await start({ issueOutcome: 'cooldown' });
    await post('register', REGISTRATION);

    expect(recorded.events).toEqual([]);
  });

  it('writes nothing for a resend', async () => {
    const recorded = await start();
    await post('register/resend', { challengeId: CHALLENGE });

    // A resend is not a registration. One account, one registration event.
    expect(recorded.events).toEqual([]);
  });

  it('writes nothing at verification, so one account produces exactly one registration event', async () => {
    const recorded = await start();
    await post('register', REGISTRATION);
    await post('register/resend', { challengeId: CHALLENGE });
    await post('register/verify', { challengeId: CHALLENGE, otp: CODE });

    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]!.eventType).toBe('auth.registration.success');
  });

  it('records only hashes, never the address, the number, the password or the code', async () => {
    const recorded = await start();
    await post('register', REGISTRATION);

    const [event] = recorded.events;
    expect(Buffer.isBuffer(event!.identifierHash)).toBe(true);
    const serialized = JSON.stringify(event);
    for (const secret of [EMAIL, PHONE, PASSWORD, NEW_USER.replace(/-/g, ''), 'Nadia']) {
      expect(serialized, secret).not.toContain(secret);
    }
    const code = recorded.sent[0]!.message.match(/\b[0-9]{6}\b/)![0];
    expect(serialized).not.toContain(code);
    // The event type has no field for any of those: what it carries is digests and a short reason code.
    expect(Object.keys(event!).sort()).toEqual([
      'eventType',
      'identifierHash',
      'ipHash',
      'reasonCode',
      'requestId',
      'userAgentHash',
      'userId',
    ]);
  });

  it('hashes the user agent it was given, and copes with none', async () => {
    const withAgent = await start();
    await post('register', REGISTRATION, TEST_INTERNAL_CREDENTIAL, { 'user-agent': 'a-canary-agent' });
    expect(Buffer.isBuffer(withAgent.events[0]!.userAgentHash)).toBe(true);
    expect(JSON.stringify(withAgent.events[0]!)).not.toContain('a-canary-agent');
    await app?.close();
    app = undefined;

    const without = await start();
    await post('register', REGISTRATION);
    expect(without.events).toHaveLength(1);
  });

  it('does not let a failed event write fail the registration', async () => {
    // C-20's writer has always been best effort: a timeline that cannot be appended to must not become a
    // registration that cannot be completed. The account exists and the code is already on its way.
    const recorded = await start({ eventThrows: true });
    const result = await post('register', REGISTRATION);

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    expect(recorded.created).toHaveLength(1);
  });

  it('leaves the neutral response untouched, event or no event', async () => {
    await start();
    const free = await post('register', REGISTRATION);
    await app?.close();
    app = undefined;

    const taken = await start({ createdUserId: null });
    const takenResult = await post('register', REGISTRATION);

    // The event is written on one path and not the other, and nothing about the two answers differs.
    expect(takenResult.status).toBe(free.status);
    expect(Object.keys(takenResult.body).sort()).toEqual(Object.keys(free.body).sort());
    expect(takenResult.body['status']).toBe(free.body['status']);
    expect(takenResult.body['challengeId']).toMatch(UUID);
    expect(taken.events).toEqual([]);
  });
});
