import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError, InvalidCredentialsError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { TOTP_STEP_UP_STORE } from '../src/auth/totp/totp.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * TOTP enrolment and the AAL2 challenge at the API boundary (Phase 7-B).
 *
 * The assertions that matter are about authority and about what leaks:
 *
 *   * the account is always the caller's own — no route accepts a user identifier, and a request without
 *     a session does no work at all;
 *   * the shared secret appears in exactly one response and is never logged, never persisted and never
 *     repeated once a factor is verified;
 *   * the `aal2` session stops at the internal hop; the browser-facing shape carries no token;
 *   * a satisfied challenge that named an operation records a step-up grant through 0042's writer, with
 *     `granted_via` and the validity fixed inside the function rather than supplied here;
 *   * every refusal is the same refusal, so nothing can be learned about somebody else's factors.
 *
 * The doubles stand in for the two things outside the process: the identity provider and the database.
 * Everything between them is the real application — the real guard, pipe, service and problem filter.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const FACTOR = '33333333-3333-4333-8333-333333333333';
const UNVERIFIED_FACTOR = '44444444-4444-4444-8444-444444444444';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const GRANT = '55555555-5555-4555-8555-555555555555';
const SECRET = 'JBSWY3DPEHPK3PXP';
const NEW_ACCESS = 'aal2-access-token-value-not-a-real-token';
const NEW_REFRESH = 'aal2-refresh-token-value-not-a-real-token';
const CODE = '123456';

interface Recorded {
  readonly calls: string[];
  readonly enrolments: Array<Record<string, unknown>>;
  readonly challenged: string[];
  readonly verified: Array<Record<string, unknown>>;
  readonly grants: Array<Record<string, unknown>>;
  readonly tokensSeen: string[];
}

interface Doubles {
  readonly factors?: Array<{ id: string; verified: boolean }>;
  readonly listFails?: 'unauthenticated' | 'unavailable';
  readonly enrolFails?: boolean;
  readonly qrSvg?: string | null;
  readonly challengeFails?: boolean;
  readonly verifyFails?: 'code' | 'unavailable';
  readonly grantOutcome?: string;
  readonly grantThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    calls: [],
    enrolments: [],
    challenged: [],
    verified: [],
    grants: [],
    tokensSeen: [],
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      listTotpFactors: async (token: string) => {
        recorded.calls.push('list-factors');
        recorded.tokensSeen.push(token);
        if (doubles.listFails === 'unauthenticated') throw new AuthenticationRequiredError();
        if (doubles.listFails === 'unavailable') throw new Error('provider unavailable');
        return doubles.factors ?? [];
      },
      enrolTotpFactor: async (token: string, input: Record<string, unknown>) => {
        recorded.calls.push('enrol-factor');
        recorded.tokensSeen.push(token);
        recorded.enrolments.push(input);
        if (doubles.enrolFails === true) throw new Error('provider unavailable');
        return {
          factorId: UNVERIFIED_FACTOR,
          secret: SECRET,
          qrSvg: doubles.qrSvg === undefined ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : doubles.qrSvg,
        };
      },
      challengeTotpFactor: async (token: string, factorId: string) => {
        recorded.calls.push('challenge-factor');
        recorded.tokensSeen.push(token);
        recorded.challenged.push(factorId);
        if (doubles.challengeFails === true) throw new Error('provider unavailable');
        return CHALLENGE;
      },
      verifyTotpFactor: async (token: string, input: Record<string, unknown>) => {
        recorded.calls.push('verify-factor');
        recorded.tokensSeen.push(token);
        recorded.verified.push(input);
        if (doubles.verifyFails === 'code') throw new InvalidCredentialsError();
        if (doubles.verifyFails === 'unavailable') throw new Error('provider unavailable');
        return { userId: USER, accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiresIn: 3600 };
      },
      // Any of these being reached is a failure of the design, not of a number.
      signInWithPassword: async () => {
        throw new Error('the TOTP surface must never sign anyone in');
      },
      updatePassword: async () => {
        throw new Error('the TOTP surface must never change a password');
      },
      createUnconfirmedUser: async () => {
        throw new Error('the TOTP surface must never create an account');
      },
    })
    .overrideProvider(TOTP_STEP_UP_STORE)
    .useValue({
      issueTotpStepUpGrant: async (input: Record<string, unknown>) => {
        recorded.calls.push('issue-grant');
        recorded.grants.push(input);
        if (doubles.grantThrows === true) throw new Error('database unavailable');
        const outcome = doubles.grantOutcome ?? 'granted';
        return outcome === 'granted'
          ? { outcome, grantId: GRANT, expiresAt: new Date(Date.now() + 600_000) }
          : { outcome, grantId: null, expiresAt: null };
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

async function call(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers: Record<string, string | null> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  const response = await app!.inject({
    method,
    url: `/v1/auth/totp${path}`,
    headers: base,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    headers: response.headers as Record<string, unknown>,
    raw: response.body,
  };
}

const VERIFIED = [{ id: FACTOR, verified: true }];
const UNVERIFIED = [{ id: UNVERIFIED_FACTOR, verified: false }];
const VERIFY_BODY = { factorId: FACTOR, challengeId: CHALLENGE, code: CODE };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /v1/auth/totp', () => {
  it('reports enrolment in two words, for the caller’s own account', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('GET', '');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'enrolled' });
    // The caller's own token, never the service credential: the answer is about them and nobody else.
    expect(recorded.tokensSeen).toEqual([SESSION_TOKEN]);
  });

  it('treats an unverified factor as not enrolled', async () => {
    await start({ factors: UNVERIFIED });
    const result = await call('GET', '');

    // Someone who started and did not finish should be offered enrolment, not a code box.
    expect(result.body).toEqual({ status: 'not_enrolled' });
  });

  it('says nothing about the factor itself', async () => {
    await start({ factors: VERIFIED });
    const result = await call('GET', '');

    expect(result.raw).not.toContain(FACTOR);
    expect(result.raw).not.toContain(USER);
    expect(Object.keys(result.body)).toEqual(['status']);
  });

  it('does no work without a session', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('GET', '', undefined, { [SESSION_TOKEN_HEADER]: null });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('still requires the internal BFF credential', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('GET', '', undefined, { [INTERNAL_CREDENTIAL_HEADER]: 'wrong-value' });

    expect(result.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('POST /v1/auth/totp/enrol', () => {
  it('returns the secret once, with a Key URI this project built', async () => {
    const recorded = await start();
    const result = await call('POST', '/enrol', {});

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['otpauthUri', 'qrSvg', 'secret', 'status']);
    expect(result.body['secret']).toBe(SECRET);

    const uri = String(result.body['otpauthUri']);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain('issuer=Marketplace');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // The label carries no contact detail: a Key URI is read off screens and shoulders.
    expect(uri).not.toContain('@');
    expect(uri).not.toContain(USER);
    expect(recorded.enrolments[0]!['issuer']).toBe('Marketplace');
  });

  it('refuses when a verified factor already exists, and creates nothing', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('POST', '/enrol', {});

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('TOTP_ALREADY_ENROLLED');
    expect(recorded.calls).not.toContain('enrol-factor');
    // Above all: no second secret is handed out for an account that already has an authenticator.
    expect(result.raw).not.toContain(SECRET);
  });

  it('enrols over an abandoned unverified attempt', async () => {
    const recorded = await start({ factors: UNVERIFIED });
    const result = await call('POST', '/enrol', {});

    expect(result.status).toBe(200);
    expect(recorded.calls).toContain('enrol-factor');
  });

  it('passes the provider’s QR through only when it is really an SVG', async () => {
    await start({ qrSvg: null });
    const withoutQr = await call('POST', '/enrol', {});

    expect(withoutQr.status).toBe(200);
    expect(withoutQr.body['qrSvg']).toBeNull();
    // The secret is still there, so manual entry always works.
    expect(withoutQr.body['secret']).toBe(SECRET);
  });

  it('returns no factor identifier, no session and no token', async () => {
    await start();
    const result = await call('POST', '/enrol', {});

    expect(result.raw).not.toContain(UNVERIFIED_FACTOR);
    expect(result.raw).not.toContain(USER);
    expect(result.raw).not.toContain(NEW_ACCESS);
    for (const field of ['factorId', 'session', 'accessToken', 'refreshToken', 'userId']) {
      expect(Object.keys(result.body)).not.toContain(field);
    }
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('does no work without a session, and is a 503 when the provider fails', async () => {
    const noSession = await start();
    const refused = await call('POST', '/enrol', {}, { [SESSION_TOKEN_HEADER]: null });
    expect(refused.status).toBe(401);
    expect(noSession.calls).toEqual([]);
    await app?.close();
    app = undefined;

    await start({ enrolFails: true });
    const unavailable = await call('POST', '/enrol', {});
    expect(unavailable.status).toBe(503);
    expect(unavailable.raw).not.toContain(SECRET);
  });
});

describe('POST /v1/auth/totp/challenge', () => {
  it('challenges the caller’s verified factor and hands the ids to the BFF only', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('POST', '/challenge', {});

    expect(result.status).toBe(200);
    expect(recorded.challenged).toEqual([FACTOR]);
    expect(result.body['challenge']).toEqual({ factorId: FACTOR, challengeId: CHALLENGE });
    // No expiry anywhere: nothing reports how long a challenge on this account lives.
    expect(Object.keys(result.body['challenge'] as object).sort()).toEqual(['challengeId', 'factorId']);
  });

  it('challenges the enrolment in progress when there is no verified factor', async () => {
    const recorded = await start({ factors: UNVERIFIED });
    await call('POST', '/challenge', {});

    // This is what completes enrolment: the same challenge and verify pair, against the new factor.
    expect(recorded.challenged).toEqual([UNVERIFIED_FACTOR]);
  });

  it('prefers a verified factor over an unverified one', async () => {
    const recorded = await start({
      factors: [{ id: UNVERIFIED_FACTOR, verified: false }, { id: FACTOR, verified: true }],
    });
    await call('POST', '/challenge', {});

    expect(recorded.challenged).toEqual([FACTOR]);
  });

  it('refuses a caller with no factor at all', async () => {
    const recorded = await start({ factors: [] });
    const result = await call('POST', '/challenge', {});

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('TOTP_NOT_ENROLLED');
    expect(recorded.calls).not.toContain('challenge-factor');
  });

  it('accepts no factor identifier from the request', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('POST', '/challenge', { factorId: 'somebody-elses-factor' });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).toEqual([]);
  });

  it('records no grant, because nobody has proved anything yet', async () => {
    const recorded = await start({ factors: VERIFIED });
    await call('POST', '/challenge', { operation: 'payout.details.change' });

    // A grant for an unanswered challenge would authorise somebody who has typed nothing.
    expect(recorded.calls).not.toContain('issue-grant');
  });

  it('refuses an operation that could not be stored in a grant', async () => {
    for (const operation of ['Payout.Change', 'a b', '', 'a'.repeat(65), "x'--"]) {
      const recorded = await start({ factors: VERIFIED });
      const result = await call('POST', '/challenge', { operation });
      expect(result.status, operation).toBe(400);
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });
});

describe('POST /v1/auth/totp/verify', () => {
  it('returns the provider’s session on the internal hop and nothing to a browser', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('POST', '/verify', VERIFY_BODY);

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('verified');
    // The envelope the BFF consumes. The BFF is the wall; this is the hop.
    expect(Object.keys(result.body['session'] as object).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'refreshToken',
    ]);
    expect(recorded.verified[0]).toEqual({ factorId: FACTOR, challengeId: CHALLENGE, code: CODE });
    // No cookie is set here: turning a session into cookies is the BFF's job alone.
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('records a step-up grant when the challenge named an operation', async () => {
    const recorded = await start({ factors: VERIFIED });
    const result = await call('POST', '/verify', { ...VERIFY_BODY, operation: 'payout.details.change' });

    expect(result.status).toBe(200);
    expect(recorded.grants).toEqual([{ userId: USER, operation: 'payout.details.change' }]);
    // Two parameters and no more: `granted_via` and the ten minutes are literals inside 0042's function,
    // so nothing here can name the source of proof or the validity.
    expect(Object.keys(recorded.grants[0]!).sort()).toEqual(['operation', 'userId']);
  });

  it('records no grant when the challenge named no operation', async () => {
    const recorded = await start({ factors: VERIFIED });
    await call('POST', '/verify', VERIFY_BODY);

    expect(recorded.calls).not.toContain('issue-grant');
  });

  it('records the grant for the account the provider verified, never one from the request', async () => {
    const recorded = await start({ factors: VERIFIED });
    await call('POST', '/verify', { ...VERIFY_BODY, operation: 'account.delete' });

    // The account comes from the session the provider just minted, so a grant cannot be aimed.
    expect(recorded.grants[0]!['userId']).toBe(USER);
  });

  it('verifies before it records, so a wrong code writes nothing', async () => {
    const recorded = await start({ factors: VERIFIED, verifyFails: 'code' });
    const result = await call('POST', '/verify', { ...VERIFY_BODY, operation: 'account.delete' });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
    expect(recorded.calls).not.toContain('issue-grant');
  });

  it('fails the request when the grant could not be recorded', async () => {
    for (const doubles of [{ grantOutcome: 'no_user' }, { grantOutcome: 'invalid_operation' }, { grantThrows: true }]) {
      const recorded = await start({ factors: VERIFIED, ...doubles });
      const result = await call('POST', '/verify', { ...VERIFY_BODY, operation: 'account.delete' });

      // The code was right, but the authorisation was not recorded. Reporting success would tell the
      // caller they may do something that has nothing behind it.
      expect(result.status, JSON.stringify(doubles)).toBe(503);
      expect(recorded.calls).toContain('verify-factor');
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('refuses a wrong code, an expired challenge and a spent one identically', async () => {
    // The provider distinguishes them; this API does not. All three arrive as the same refusal from the
    // client, and all three leave as the same status, code and body.
    const answers: Result[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await start({ factors: VERIFIED, verifyFails: 'code' });
      answers.push(await call('POST', '/verify', VERIFY_BODY));
      await app?.close();
      app = undefined;
    }
    await start();

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual(answers[0]!.body);
      expect(answer.body['code']).toBe('AUTHENTICATION_FAILED');
    }
  });

  it('never returns a token, an account or the code to a browser-facing field', async () => {
    await start({ factors: VERIFIED });
    const result = await call('POST', '/verify', VERIFY_BODY);

    // The session is in the envelope the BFF strips; nothing else in the body carries one.
    const withoutSession = { ...result.body };
    delete withoutSession['session'];
    expect(withoutSession).toEqual({ status: 'verified' });
    expect(JSON.stringify(withoutSession)).not.toContain(NEW_ACCESS);
    expect(JSON.stringify(withoutSession)).not.toContain(NEW_REFRESH);
    expect(JSON.stringify(withoutSession)).not.toContain(USER);
    expect(JSON.stringify(withoutSession)).not.toContain(CODE);
  });

  it('validates the code and the identifiers before any provider call', async () => {
    for (const payload of [
      { ...VERIFY_BODY, code: '12345' },
      { ...VERIFY_BODY, code: 'abcdef' },
      { ...VERIFY_BODY, factorId: '../../etc/passwd' },
      { ...VERIFY_BODY, challengeId: "x' or 1=1" },
      { ...VERIFY_BODY, userId: USER },
      {},
    ]) {
      const recorded = await start({ factors: VERIFIED });
      const result = await call('POST', '/verify', payload);
      expect(result.status, JSON.stringify(payload)).toBe(400);
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('does no work without a session, and still requires the BFF credential', async () => {
    const recorded = await start({ factors: VERIFIED });
    const noSession = await call('POST', '/verify', VERIFY_BODY, { [SESSION_TOKEN_HEADER]: null });
    const noCredential = await call('POST', '/verify', VERIFY_BODY, {
      [INTERNAL_CREDENTIAL_HEADER]: null,
    });

    expect(noSession.status).toBe(401);
    expect(noCredential.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  });

  it('is a 503 when the provider fails, never a refused code', async () => {
    await start({ factors: VERIFIED, verifyFails: 'unavailable' });
    const result = await call('POST', '/verify', VERIFY_BODY);

    // An outage rendered as "that code was not accepted" would have people retyping a correct code.
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the surface as a whole', () => {
  it('offers no way to remove a factor and no backup codes', async () => {
    await start({ factors: VERIFIED });

    for (const [method, path] of [
      ['DELETE', ''],
      ['DELETE', '/enrol'],
      ['POST', '/remove'],
      ['POST', '/disable'],
      ['POST', '/backup-codes'],
      ['GET', '/backup-codes'],
    ] as const) {
      const response = await app!.inject({
        method,
        url: `/v1/auth/totp${path}`,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
        },
        payload: '{}',
      });
      // D9's recovery path is gated by the specification on O-1 tests 4 and 5, which have not been run.
      expect([404, 405], `${method} ${path}`).toContain(response.statusCode);
    }
  });

  it('never presents the service credential to the provider', async () => {
    const recorded = await start({ factors: VERIFIED });
    await call('GET', '');
    await call('POST', '/challenge', {});
    await call('POST', '/verify', VERIFY_BODY);

    // Every MFA call answers for the person making it. The service credential would make each of them
    // answer for everybody.
    expect(new Set(recorded.tokensSeen)).toEqual(new Set([SESSION_TOKEN]));
    expect(recorded.tokensSeen).not.toContain(TEST_ENV.supabaseSecretKey);
  });

  it('never signs anyone in, changes a password or creates an account', async () => {
    // The doubles throw if any of those are reached; getting through the flow proves none was.
    const recorded = await start({ factors: UNVERIFIED });
    await call('POST', '/enrol', {});
    await call('POST', '/challenge', {});
    const verified = await call('POST', '/verify', { ...VERIFY_BODY, factorId: UNVERIFIED_FACTOR });

    expect(verified.status).toBe(200);
    expect(recorded.calls).toEqual([
      'list-factors',
      'enrol-factor',
      'list-factors',
      'challenge-factor',
      'verify-factor',
    ]);
  });
});
