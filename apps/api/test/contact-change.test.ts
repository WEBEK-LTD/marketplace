import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE, type AuthSecurityEvent } from '../src/auth/auth-security-events.service.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { OTP_CHALLENGE_STORE } from '../src/auth/otp/otp.service.js';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';
import { CONTACT_CHANGE_STORE } from '../src/users/contact-change.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The F4 phone contact change at the API boundary.
 *
 * The assertions that matter are about authority and about what the flow leaves behind: the account is
 * the caller's own and can never be named by a request; a challenge belonging to someone else is refused
 * as if it did not exist; the new number is the one the code was sent to; the previous number is told
 * afterwards; and no session is created, revoked or touched at any point.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OLD_PHONE = '+201000000001';
const NEW_PHONE = '+201555000111';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const CODE = '123456';

interface Recorded {
  readonly calls: string[];
  readonly events: AuthSecurityEvent[];
  readonly sent: Array<{ to: string; message: string }>;
  readonly issued: Array<Record<string, unknown>>;
  readonly verified: Array<{ challengeId: string; userId: string }>;
  readonly phoneUpdates: Array<{ userId: string; phone: string }>;
  readonly tokensSeen: string[];
  readonly queued: Array<Record<string, unknown>>;
}

interface Doubles {
  readonly getUserFails?: 'unauthenticated' | 'unavailable';
  readonly issueOutcome?: 'issued' | 'cooldown' | 'rate_limited_destination_hour';
  readonly deliver?: 'sent' | 'failed';
  readonly verifyOutcome?: string;
  readonly newPhone?: string | null;
  readonly previousPhone?: string | null;
  readonly updatePhoneThrows?: boolean;
  readonly notificationThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    calls: [],
    events: [],
    sent: [],
    issued: [],
    verified: [],
    phoneUpdates: [],
    tokensSeen: [],
    queued: [],
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (token: string) => {
        recorded.calls.push('get-user');
        recorded.tokensSeen.push(token);
        if (doubles.getUserFails === 'unauthenticated') throw new AuthenticationRequiredError();
        if (doubles.getUserFails === 'unavailable') throw new Error('provider unavailable');
        return { id: USER, phone: OLD_PHONE };
      },
      updatePhone: async (userId: string, phone: string) => {
        recorded.calls.push('update-phone');
        if (doubles.updatePhoneThrows === true) throw new Error('provider unavailable');
        recorded.phoneUpdates.push({ userId, phone });
      },
      signInWithPassword: async () => {
        throw new Error('a contact change must never sign anyone in');
      },
      updatePassword: async () => {
        throw new Error('a contact change must never change a password');
      },
      revokeAllSessions: async () => {
        recorded.calls.push('revoke-sessions');
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
          : { outcome, challengeId: null, outboxId: null, sendCount: null, retryAfterSeconds: 60, expiresAt: null };
      },
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
      verifyOtpChallenge: async () => 'verified',
    })
    .overrideProvider(CONTACT_CHANGE_STORE)
    .useValue({
      verifyContactChangeOtp: async (input: { challengeId: string; userId: string }) => {
        recorded.calls.push('verify-otp');
        recorded.verified.push({ challengeId: input.challengeId, userId: input.userId });
        const outcome = doubles.verifyOutcome ?? 'verified';
        return {
          outcome,
          newPhoneE164: outcome === 'verified' ? (doubles.newPhone ?? NEW_PHONE) : null,
        };
      },
      verifiedContactForUser: async () => {
        recorded.calls.push('previous-contact');
        return doubles.previousPhone === undefined ? OLD_PHONE : doubles.previousPhone;
      },
      queueWhatsAppMessage: async (input: Record<string, unknown>) => {
        recorded.calls.push('queue-notification');
        if (doubles.notificationThrows === true) throw new Error('outbox unavailable');
        recorded.queued.push(input);
        return 'bbbbbbbb-0000-4000-8000-000000000001';
      },
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
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

async function post(step: 'start' | 'verify', payload: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: `/v1/users/me/contact/phone/${step}`,
    headers: {
      'content-type': 'application/json',
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
      ...headers,
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /v1/users/me/contact/phone/start', () => {
  it('sends a code to the new number for the caller’s own account', async () => {
    const recorded = await start();
    const result = await post('start', { phone: NEW_PHONE });

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    // The challenge travels to the BFF only; the approved public body is the status alone.
    expect((result.body['challenge'] as Record<string, string>)['id']).toBe(CHALLENGE);

    // The account came from the token, and the OTP is an ordinary phone_verify challenge for it.
    expect(recorded.tokensSeen).toEqual([SESSION_TOKEN]);
    expect(recorded.issued[0]?.['purpose']).toBe('phone_verify');
    expect(recorded.issued[0]?.['userId']).toBe(USER);
    expect(recorded.issued[0]?.['templateName']).toBe('contact_change_phone_otp');
    expect(recorded.issued[0]?.['toPhoneE164']).toBe(NEW_PHONE);

    // Delivery is Waabek, the message carries the code and nothing else about the account.
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]?.to).toBe(NEW_PHONE);
    expect(recorded.sent[0]?.message).toMatch(/^\d{6} is your code to confirm this number/);
    expect(recorded.sent[0]?.message).not.toContain(USER);

    // No session anywhere.
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(recorded.calls).not.toContain('revoke-sessions');
  });

  it('refuses a request with no session, before anything is attempted', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/users/me/contact/phone/start',
      headers: { 'content-type': 'application/json', [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
      payload: JSON.stringify({ phone: NEW_PHONE }),
    });

    expect(response.statusCode).toBe(401);
    expect((JSON.parse(response.body) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toHaveLength(0);
  });

  it('refuses a session the provider does not accept', async () => {
    const recorded = await start({ getUserFails: 'unauthenticated' });
    const result = await post('start', { phone: NEW_PHONE });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).not.toContain('issue-otp');
  });

  it.each([
    ['not a phone at all', 'not-a-phone'],
    ['without the country code', '01000000001'],
    ['with a leading zero country code', '+0100000001'],
    ['too short', '+2010'],
    ['too long', '+2010000000000000000'],
  ])('rejects a new number %s', async (_label, phone) => {
    const recorded = await start();
    const result = await post('start', { phone });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).toHaveLength(0);
  });

  it('never accepts an account named by the request', async () => {
    const recorded = await start();
    const result = await post('start', { phone: NEW_PHONE, userId: '99999999-9999-4999-8999-999999999999' });

    expect(result.status).toBe(400);
    expect(recorded.calls).toHaveLength(0);
  });

  it('answers 429 when the approved send limits or the cooldown refuse the request', async () => {
    await start({ issueOutcome: 'rate_limited_destination_hour' });
    const limited = await post('start', { phone: NEW_PHONE });
    expect(limited.status).toBe(429);
    expect(limited.body['code']).toBe('THROTTLED');
    await app?.close();
    app = undefined;

    await start({ issueOutcome: 'cooldown' });
    const cooling = await post('start', { phone: NEW_PHONE });
    expect(cooling.status).toBe(429);
    expect(cooling.body['code']).toBe('THROTTLED');
  });

  it('answers 503 when delivery fails or the provider cannot be reached, and never fails open', async () => {
    await start({ deliver: 'failed' });
    expect((await post('start', { phone: NEW_PHONE })).status).toBe(503);
    await app?.close();
    app = undefined;

    await start({ getUserFails: 'unavailable' });
    const unavailable = await post('start', { phone: NEW_PHONE });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('still requires the internal BFF credential', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/users/me/contact/phone/start',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: SESSION_TOKEN },
      payload: JSON.stringify({ phone: NEW_PHONE }),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /v1/users/me/contact/phone/verify', () => {
  it('changes the phone, tells the previous number and records the event, in that order', async () => {
    const recorded = await start();
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
    expect(recorded.calls).toEqual([
      'get-user',
      'verify-otp',
      // The old number is read while it is still the account's.
      'previous-contact',
      'update-phone',
      'queue-notification',
      'waabek',
    ]);
    expect(recorded.phoneUpdates).toEqual([{ userId: USER, phone: NEW_PHONE }]);
    // The verification is bound to the caller's account, and the challenge came from the request.
    expect(recorded.verified).toEqual([{ challengeId: CHALLENGE, userId: USER }]);
  });

  it('notifies the previous number with the approved template and no secret', async () => {
    const recorded = await start();
    await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(recorded.queued).toEqual([
      { toPhoneE164: OLD_PHONE, templateName: 'contact_change_phone_completed', templateLocale: 'en', userId: USER },
    ]);
    expect(recorded.sent[0]?.to).toBe(OLD_PHONE);
    expect(recorded.sent[0]?.message).toContain('phone number on your account was changed');
    expect(recorded.sent[0]?.message).not.toContain(CODE);
    expect(recorded.sent[0]?.message).not.toContain(NEW_PHONE);
  });

  it('records the approved security event and nothing that could carry a secret', async () => {
    const recorded = await start();
    await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.contact_change.success']);
    const event = recorded.events[0];
    expect(event?.userId).toBe(USER);
    expect(event?.reasonCode).toBe('contact_change_completed');
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(CODE);
    expect(serialised).not.toContain(NEW_PHONE);
    expect(serialised).not.toContain(OLD_PHONE);
    expect(serialised).not.toContain(SESSION_TOKEN);
  });

  it('succeeds even when the notification cannot be queued or delivered', async () => {
    const queueFailed = await start({ notificationThrows: true });
    expect((await post('verify', { challengeId: CHALLENGE, otp: CODE })).status).toBe(200);
    expect(queueFailed.phoneUpdates).toHaveLength(1);
    await app?.close();
    app = undefined;

    const sendFailed = await start({ deliver: 'failed' });
    expect((await post('verify', { challengeId: CHALLENGE, otp: CODE })).status).toBe(200);
    expect(sendFailed.phoneUpdates).toHaveLength(1);
  });

  it('changes the phone for an account that had none to notify', async () => {
    const recorded = await start({ previousPhone: null });
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(200);
    expect(recorded.phoneUpdates).toHaveLength(1);
    expect(recorded.sent).toHaveLength(0);
  });

  it.each([
    ['a wrong code', 'invalid'],
    ['an expired challenge', 'expired'],
    ['a challenge already used', 'consumed'],
    ['a challenge whose attempts are spent', 'too_many_attempts'],
    ['a challenge belonging to another account', 'not_found'],
    ['a challenge whose destination cannot be resolved', 'destination_unavailable'],
  ] as const)('refuses %s with the same generic 401 and changes nothing', async (_label, outcome) => {
    const recorded = await start({ verifyOutcome: outcome });
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(result.raw).not.toMatch(/expired|consumed|attempts|destination|another/i);
    expect(recorded.calls).not.toContain('update-phone');
    expect(recorded.events).toHaveLength(0);
    expect(recorded.sent).toHaveLength(0);
  });

  it('rejects a code of the wrong shape before the database is touched', async () => {
    const recorded = await start();
    const result = await post('verify', { challengeId: CHALLENGE, otp: '12345' });

    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('verify-otp');
  });

  it('refuses without a session and never verifies anything', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/users/me/contact/phone/verify',
      headers: { 'content-type': 'application/json', [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
      payload: JSON.stringify({ challengeId: CHALLENGE, otp: CODE }),
    });

    expect(response.statusCode).toBe(401);
    expect((JSON.parse(response.body) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toHaveLength(0);
  });

  it('answers 503 when the provider cannot apply the change, and records nothing', async () => {
    const recorded = await start({ updatePhoneThrows: true });
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(recorded.events).toHaveLength(0);
    expect(recorded.sent).toHaveLength(0);
  });

  it('creates no session and revokes none', async () => {
    const recorded = await start();
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.raw).not.toMatch(/token|session/i);
    expect(recorded.calls).not.toContain('revoke-sessions');
  });
});
