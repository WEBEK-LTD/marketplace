import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { RESET_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE, type AuthSecurityEvent } from '../src/auth/auth-security-events.service.js';
import { OTP_CHALLENGE_STORE } from '../src/auth/otp/otp.service.js';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';
import { PASSWORD_RESET_TOKEN_STORE } from '../src/auth/password-reset/password-reset.service.js';
import { RECOVERY_STORE } from '../src/auth/password-reset/recovery.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The F3 recovery routes at the API boundary.
 *
 * The assertions that matter are about what a caller can *learn* and what the flow leaves behind. A
 * known identifier and an unknown one must be indistinguishable at `start`; a wrong code, an unknown
 * challenge and a spent one must be indistinguishable at `verify`; and a reset must change the password,
 * cut the sessions and spend the token in that order — never spending it when the password is refused.
 *
 * The doubles stand in for the three things outside the process: the database, Supabase and Waabek.
 * Everything between them is the real application.
 */

const KNOWN_IDENTIFIER = 'person@example.test';
const UNKNOWN_IDENTIFIER = 'nobody@example.test';
const KNOWN_USER = '11111111-1111-4111-8111-111111111111';
const PHONE = '+201000000001';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const CODE = '123456';
const NEW_PASSWORD = 'correct horse battery staple';

interface Recorded {
  readonly calls: string[];
  readonly events: AuthSecurityEvent[];
  readonly sent: Array<{ to: string; message: string }>;
  readonly passwords: Array<{ userId: string; password: string }>;
  readonly revoked: string[];
  readonly consumed: Array<{ tokenHash: Buffer; expectedUserId: string | null }>;
  readonly counters: Array<{ bucket: string; limit: number }>;
  /** The reset token the API issued, captured from the server-to-server envelope. */
  token: string | null;
}

interface Doubles {
  readonly contact?: { userId: string; phoneE164: string } | null;
  readonly contactThrows?: boolean;
  readonly allowed?: boolean;
  readonly countersThrow?: boolean;
  readonly otpOutcome?: 'verified' | 'invalid' | 'expired' | 'consumed' | 'too_many_attempts' | 'not_found';
  readonly issueOutcome?: 'issued' | 'cooldown' | 'rate_limited_destination_hour';
  readonly deliver?: 'sent' | 'failed';
  readonly tokenStatus?: { status: string; userId: string | null };
  readonly consumeOutcome?: 'consumed' | 'already_consumed' | 'expired' | 'wrong_user' | 'not_found';
  readonly updatePasswordThrows?: boolean;
  readonly revokeThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    calls: [],
    events: [],
    sent: [],
    passwords: [],
    revoked: [],
    consumed: [],
    counters: [],
    token: null,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(RECOVERY_STORE)
    .useValue({
      passwordResetContact: async () => {
        recorded.calls.push('contact');
        if (doubles.contactThrows === true) throw new Error('database unavailable');
        return doubles.contact ?? null;
      },
      verifiedContactForUser: async () => PHONE,
      verifyPasswordResetOtp: async () => {
        recorded.calls.push('verify-otp');
        const outcome = doubles.otpOutcome ?? 'verified';
        return outcome === 'verified'
          ? { outcome, tokenId: 'aaaaaaaa-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 900_000) }
          : { outcome, tokenId: null, expiresAt: null };
      },
      passwordResetTokenStatus: async () => {
        recorded.calls.push('token-status');
        return doubles.tokenStatus ?? { status: 'valid', userId: KNOWN_USER };
      },
      hit: async (bucket: string, _subject: Buffer, _window: number, limit: number) => {
        recorded.counters.push({ bucket, limit });
        if (doubles.countersThrow === true) throw new Error('counter unavailable');
        return doubles.allowed ?? true;
      },
      queueWhatsAppMessage: async () => {
        recorded.calls.push('queue-notification');
        return 'bbbbbbbb-0000-4000-8000-000000000001';
      },
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
    })
    .overrideProvider(OTP_CHALLENGE_STORE)
    .useValue({
      issueOtpChallenge: async () => {
        recorded.calls.push('issue-otp');
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
    .overrideProvider(PASSWORD_RESET_TOKEN_STORE)
    .useValue({
      issuePasswordResetToken: async () => ({
        outcome: 'issued',
        tokenId: 'aaaaaaaa-0000-4000-8000-000000000001',
        expiresAt: new Date(Date.now() + 900_000),
      }),
      consumePasswordResetToken: async (input: { tokenHash: Buffer; expectedUserId: string | null }) => {
        recorded.calls.push('consume');
        recorded.consumed.push(input);
        const outcome = doubles.consumeOutcome ?? 'consumed';
        return outcome === 'consumed'
          ? { outcome, userId: KNOWN_USER, tokenId: 'aaaaaaaa-0000-4000-8000-000000000001' }
          : { outcome, userId: null, tokenId: null };
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
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      signInWithPassword: async () => {
        throw new Error('recovery must never sign anyone in');
      },
      updatePassword: async (userId: string, password: string) => {
        recorded.calls.push('update-password');
        if (doubles.updatePasswordThrows === true) throw new Error('provider unavailable');
        recorded.passwords.push({ userId, password });
      },
      revokeAllSessions: async (userId: string) => {
        recorded.calls.push('revoke-sessions');
        if (doubles.revokeThrows === true) throw new Error('provider unavailable');
        recorded.revoked.push(userId);
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

async function post(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: `/v1/auth/recovery/${path}`,
    headers: {
      'content-type': 'application/json',
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
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

describe('POST /v1/auth/recovery/start', () => {
  it('sends a code to the account’s verified contact and answers with a challenge id', async () => {
    const recorded = await start({ contact: { userId: KNOWN_USER, phoneE164: PHONE } });
    const result = await post('start', { identifier: KNOWN_IDENTIFIER });

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    expect(result.body['challengeId']).toBe(CHALLENGE);
    expect(Object.keys(result.body).sort()).toEqual(['challengeId', 'status']);
    // The code went to the verified contact and nowhere else, and the message never names the account.
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]?.to).toBe(PHONE);
    expect(recorded.sent[0]?.message).toMatch(/^\d{6} is your password reset code/);
    expect(recorded.sent[0]?.message).not.toContain(KNOWN_IDENTIFIER);
    // No session anywhere: no cookie, no token.
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.raw).not.toMatch(/token/i);
  });

  it('answers an unknown identifier exactly as it answers a known one', async () => {
    await start({ contact: { userId: KNOWN_USER, phoneE164: PHONE } });
    const known = await post('start', { identifier: KNOWN_IDENTIFIER });
    await app?.close();
    app = undefined;

    const unknownRun = await start({ contact: null });
    const unknown = await post('start', { identifier: UNKNOWN_IDENTIFIER });

    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort());
    expect(unknown.body['status']).toBe(known.body['status']);
    // Same shape of identifier, different value: a UUID that matches nothing.
    expect(String(unknown.body['challengeId'])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(unknown.body['challengeId']).not.toBe(known.body['challengeId']);
    expect(unknown.headers['content-type']).toBe(known.headers['content-type']);
    // Nothing was sent, and nothing in the answer says so.
    expect(unknownRun.sent).toHaveLength(0);
  });

  it('counts an unknown identifier against the same approved limits as a real one', async () => {
    const recorded = await start({ contact: null });
    await post('start', { identifier: UNKNOWN_IDENTIFIER });

    expect(recorded.counters.map((counter) => `${counter.bucket}:${counter.limit}`)).toEqual([
      'otp.send.ip.hour:20',
      'otp.send.destination.hour:5',
      'otp.send.destination.day:10',
    ]);
  });

  it('refuses with 429 when a limit is reached, and with 429 for an unknown identifier too', async () => {
    await start({ contact: { userId: KNOWN_USER, phoneE164: PHONE }, allowed: false });
    const known = await post('start', { identifier: KNOWN_IDENTIFIER });
    expect(known.status).toBe(429);
    expect(known.body['code']).toBe('TOO_MANY_REQUESTS');
    await app?.close();
    app = undefined;

    await start({ contact: null, allowed: false });
    const unknown = await post('start', { identifier: UNKNOWN_IDENTIFIER });
    expect(unknown.status).toBe(429);
    expect(unknown.body['code']).toBe('TOO_MANY_REQUESTS');
  });

  it('answers 429 when the approved send limits refuse the message', async () => {
    await start({ contact: { userId: KNOWN_USER, phoneE164: PHONE }, issueOutcome: 'rate_limited_destination_hour' });
    const result = await post('start', { identifier: KNOWN_IDENTIFIER });

    expect(result.status).toBe(429);
    expect(result.body['code']).toBe('TOO_MANY_REQUESTS');
  });

  it('answers 503 when delivery fails or the counters cannot answer, and never fails open', async () => {
    await start({ contact: { userId: KNOWN_USER, phoneE164: PHONE }, deliver: 'failed' });
    expect((await post('start', { identifier: KNOWN_IDENTIFIER })).status).toBe(503);
    await app?.close();
    app = undefined;

    await start({ countersThrow: true });
    const refused = await post('start', { identifier: KNOWN_IDENTIFIER });
    expect(refused.status).toBe(503);
    expect(refused.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503, not 200, when the contact lookup itself fails', async () => {
    await start({ contactThrows: true });
    expect((await post('start', { identifier: KNOWN_IDENTIFIER })).status).toBe(503);
  });

  it('rejects a malformed body with 400 and never 401', async () => {
    await start();
    const result = await post('start', { identifier: '' });
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
  });

  it('still requires the internal BFF credential', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/recovery/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ identifier: KNOWN_IDENTIFIER }),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /v1/auth/recovery/verify', () => {
  it('returns the reset token to the BFF only, with no session and no cookie', async () => {
    await start();
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    const reset = result.body['reset'] as Record<string, string>;
    expect(typeof reset['token']).toBe('string');
    expect(reset['token']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The link is built server-side from WEB_PUBLIC_ORIGIN and carries the token exactly once.
    expect(reset['link']).toBe(`https://web.invalid/auth/recovery?token=${reset['token']}`);
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['a wrong code', 'invalid'],
    ['an expired challenge', 'expired'],
    ['a challenge already used', 'consumed'],
    ['a challenge whose attempts are spent', 'too_many_attempts'],
    ['a challenge that does not exist', 'not_found'],
  ] as const)('refuses %s with the same generic 401', async (_label, outcome) => {
    await start({ otpOutcome: outcome });
    const result = await post('verify', { challengeId: CHALLENGE, otp: CODE });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(result.body['detail']).toBe('Authentication failed.');
    expect(result.raw).not.toMatch(/expired|consumed|attempts|challenge/i);
  });

  it('rejects a code of the wrong shape before the database is touched', async () => {
    const recorded = await start();
    const result = await post('verify', { challengeId: CHALLENGE, otp: '12345' });

    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('verify-otp');
  });
});

describe('POST /v1/auth/recovery/reset', () => {
  const RESET_TOKEN = 'a'.repeat(43);

  it('changes the password, revokes the sessions and consumes the token, in that order', async () => {
    const recorded = await start();
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
    expect(recorded.calls).toEqual([
      'token-status',
      'update-password',
      'revoke-sessions',
      'consume',
      'queue-notification',
      'waabek',
    ]);
    expect(recorded.passwords).toEqual([{ userId: KNOWN_USER, password: NEW_PASSWORD }]);
    expect(recorded.revoked).toEqual([KNOWN_USER]);
    // The consumption is bound to the account the token was issued for.
    expect(recorded.consumed[0]?.expectedUserId).toBe(KNOWN_USER);
    // No session is created: no cookie, no token in the body.
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.raw).not.toContain(RESET_TOKEN);
  });

  it('records the approved security event and nothing that could carry a secret', async () => {
    const recorded = await start();
    await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(recorded.events.map((event) => event.eventType)).toEqual(['auth.password_reset.success']);
    const event = recorded.events[0];
    expect(event?.userId).toBe(KNOWN_USER);
    expect(event?.reasonCode).toBe('password_reset_completed');
    expect(Buffer.isBuffer(event?.identifierHash)).toBe(true);
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(RESET_TOKEN);
    expect(serialised).not.toContain(NEW_PASSWORD);
  });

  it('sends the post-reset notification without a password, a token or a digest', async () => {
    const recorded = await start();
    await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(recorded.sent).toHaveLength(1);
    expect(recorded.sent[0]?.to).toBe(PHONE);
    expect(recorded.sent[0]?.message).toContain('Your password was changed');
    expect(recorded.sent[0]?.message).not.toContain(NEW_PASSWORD);
    expect(recorded.sent[0]?.message).not.toContain(RESET_TOKEN);
  });

  it('still succeeds when the notification cannot be sent', async () => {
    const recorded = await start({ deliver: 'failed' });
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(200);
    expect(recorded.consumed).toHaveLength(1);
  });

  it('does not consume the token when the password fails the policy', async () => {
    const recorded = await start();
    const result = await post('reset', { newPassword: 'short' }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).not.toContain('consume');
    expect(recorded.calls).not.toContain('update-password');
    // Nothing at all happened: the policy check is the first thing the flow does.
    expect(recorded.calls).toHaveLength(0);
  });

  it.each([
    ['an unknown token', 'not_found'],
    ['an expired token', 'expired'],
    ['a token already used', 'already_consumed'],
  ] as const)('refuses %s with the same generic 401 and changes nothing', async (_label, status) => {
    const recorded = await start({ tokenStatus: { status, userId: null } });
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(recorded.calls).not.toContain('update-password');
    expect(recorded.calls).not.toContain('consume');
  });

  it('refuses a token that belongs to another account', async () => {
    const recorded = await start({ consumeOutcome: 'wrong_user' });
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(401);
    expect(recorded.consumed).toHaveLength(1);
  });

  it('refuses when the token header is missing, without saying which part failed', async () => {
    const recorded = await start();
    const result = await post('reset', { newPassword: NEW_PASSWORD });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(recorded.calls).toHaveLength(0);
  });

  it('never accepts a token from the browser body', async () => {
    const recorded = await start();
    const result = await post('reset', { newPassword: NEW_PASSWORD, resetToken: RESET_TOKEN });

    // The body is strict: an extra field is a validation failure, and the token is ignored either way.
    expect(result.status).toBe(400);
    expect(recorded.calls).toHaveLength(0);
  });

  it('leaves the token unconsumed when the provider cannot change the password', async () => {
    const recorded = await start({ updatePasswordThrows: true });
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    expect(result.status).toBe(503);
    expect(recorded.calls).not.toContain('consume');
  });

  it('leaves the token unconsumed when the sessions cannot be revoked', async () => {
    const recorded = await start({ revokeThrows: true });
    const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });

    // A password changed without the old sessions being cut is not a completed reset.
    expect(result.status).toBe(503);
    expect(recorded.calls).not.toContain('consume');
  });

  it('lets exactly one of several simultaneous resets win', async () => {
    let taken = false;
    const recorded = await start();
    // The stub store consumes once; the API must report one success and refuse the rest.
    const moduleConsume = recorded.consumed;
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const result = await post('reset', { newPassword: NEW_PASSWORD }, { [RESET_TOKEN_HEADER]: RESET_TOKEN });
        if (result.status === 200) taken = true;
        return result.status;
      }),
    );

    expect(taken).toBe(true);
    expect(moduleConsume.length).toBe(5);
    expect(results.every((status) => status === 200 || status === 401)).toBe(true);
  });
});
