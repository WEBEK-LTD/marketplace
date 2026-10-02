import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { PseudonymousUserId } from '@repo/server-config';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE } from '../src/auth/auth-security-events.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { OTP_CHALLENGE_STORE } from '../src/auth/otp/otp.service.js';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';
import { CONTACT_CHANGE_STORE } from '../src/users/contact-change.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The pseudonymous user ID in API request logs (C-13, O8-12).
 *
 * This exercises the production wiring rather than the primitive: a real authenticated route, the real
 * request scope opened in `configureApp`, and the real logger. What has to be true is that an
 * authenticated request's lines name the caller pseudonymously, that an anonymous request's lines name
 * nobody at all, and that the raw UUID appears in no line either way.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const NEW_PHONE = '+201555000111';

const expected = new PseudonymousUserId(TEST_ENV.pseudonymousUserIdKey).derive(USER);

let app: NestFastifyApplication | undefined;
let lines: string[] = [];

async function start(options: { authenticated: boolean } = { authenticated: true }): Promise<void> {
  lines = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (!options.authenticated) throw new Error('no session in this scenario');
        return { id: USER, phone: null };
      },
      updatePhone: async () => undefined,
      signInWithPassword: async () => {
        throw new Error('not used');
      },
      updatePassword: async () => {
        throw new Error('not used');
      },
      revokeAllSessions: async () => undefined,
    })
    .overrideProvider(OTP_CHALLENGE_STORE)
    .useValue({
      issueOtpChallenge: async () => ({
        outcome: 'issued',
        challengeId: '22222222-2222-4222-8222-222222222222',
        outboxId: 'cccccccc-0000-4000-8000-000000000001',
        sendCount: 1,
        retryAfterSeconds: null,
        expiresAt: new Date(Date.now() + 600_000),
      }),
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
      verifyOtpChallenge: async () => 'verified',
    })
    .overrideProvider(CONTACT_CHANGE_STORE)
    .useValue({
      verifyContactChangeOtp: async () => ({ outcome: 'verified', newPhoneE164: NEW_PHONE }),
      verifiedContactForUser: async () => null,
      queueWhatsAppMessage: async () => 'bbbbbbbb-0000-4000-8000-000000000001',
      beginOtpDelivery: async () => true,
      settleOtpDelivery: async () => true,
    })
    .overrideProvider(WaabekClient)
    .useValue({ send: async () => ({ status: 'sent', providerMessageId: 'provider-message-id' }) })
    .overrideProvider(AUTH_SECURITY_EVENT_STORE)
    .useValue({ recordAuthSecurityEvent: async () => undefined })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: (line: string) => void lines.push(line) } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function logs(): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Only the lines written while serving a request; start-up lines belong to no request. */
function requestLogs(): Array<Record<string, unknown>> {
  return logs().filter((line) => 'reqId' in line || 'requestId' in line);
}

async function callContactStart(headers: Record<string, string>): Promise<number> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/users/me/contact/phone/start',
    headers: { 'content-type': 'application/json', [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, ...headers },
    payload: JSON.stringify({ phone: NEW_PHONE }),
  });
  return response.statusCode;
}

describe('the pseudonymous user ID in API logs', () => {
  it('names the caller on an authenticated request, pseudonymously', async () => {
    await start();
    const status = await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    expect(status).toBe(200);

    const identified = requestLogs().filter((line) => line['user_pseudo_id'] !== undefined);
    expect(identified.length).toBeGreaterThan(0);
    for (const line of identified) expect(line['user_pseudo_id']).toBe(expected);
  });

  it('carries the same value on every line of that request, including the response line', async () => {
    await start();
    await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    // The identity is known part-way through the request, so the completion line is the one that
    // proves the scope outlived the handler.
    const completed = requestLogs().find((line) => line['msg'] === 'request completed');
    expect(completed?.['user_pseudo_id']).toBe(expected);
  });

  it('never writes the raw user UUID, and never both forms of the identity', async () => {
    await start();
    await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    for (const line of lines) {
      expect(line).not.toContain(USER);
      expect(line).not.toContain(USER.replace(/-/g, ''));
    }
    for (const line of logs()) {
      expect(line['userId']).toBeUndefined();
      expect(line['user_id']).toBeUndefined();
    }
  });

  it('writes no identity field at all on an anonymous request', async () => {
    await start();
    // No session header: the BFF credential alone does not identify a person.
    const status = await callContactStart({});
    expect(status).toBe(401);
    for (const line of logs()) expect(line['user_pseudo_id']).toBeUndefined();
  });

  it('writes no identity field when the request never resolves a user', async () => {
    await start({ authenticated: false });
    const status = await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    expect(status).toBe(503);
    for (const line of logs()) expect(line['user_pseudo_id']).toBeUndefined();
  });

  it('leaves request IDs and trace correlation exactly as they were', async () => {
    await start();
    await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    const completed = requestLogs().find((line) => line['msg'] === 'request completed');
    expect(typeof completed?.['requestId']).toBe('string');
    expect(completed?.['module']).toBe('http');
    // Trace fields still come from the tracer alone: no provider is registered in this suite, so they
    // are absent here exactly as they were before this change. Adding an identity changed neither the
    // condition under which they appear nor their names.
    expect(completed).not.toHaveProperty('traceId');
    expect(completed).not.toHaveProperty('spanId');
  });

  it('keeps the key itself out of every line', async () => {
    await start();
    await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN });
    for (const line of lines) {
      expect(line).not.toContain(TEST_ENV.pseudonymousUserIdKey);
      expect(line).not.toContain('PSEUDONYMOUS_USER_ID_KEY');
    }
  });

  it('still redacts the credentials it redacted before', async () => {
    await start();
    await callContactStart({ [SESSION_TOKEN_HEADER]: SESSION_TOKEN, cookie: 'session=secret-cookie-value' });
    for (const line of lines) {
      expect(line).not.toContain('secret-cookie-value');
      expect(line).not.toContain(SESSION_TOKEN);
      expect(line).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });
});
