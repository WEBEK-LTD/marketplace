import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { REFRESH_TOKEN_HEADER, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { InvalidCredentialsError, AuthProviderUnavailableError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Session continuity at the API boundary (Phase 5-A).
 *
 * What these assertions protect, in order of how much it would cost to get wrong:
 *
 *   * a refresh renews and **rotates** — a new refresh token comes back, not the one that was spent;
 *   * every refusal is the same refusal, so nobody can tell an expired token from a reused one;
 *   * logout ends the caller's own session and **never** calls the administrative revocation that would
 *     sign the same person out everywhere;
 *   * logout is idempotent: a token the provider no longer holds is a success;
 *   * neither route accepts the other's token;
 *   * login is untouched by all of it.
 */

const REFRESH_TOKEN = 'caller-refresh-token-value-not-a-real-token';
const NEW_ACCESS = 'renewed-access-token-value-not-a-real-token';
const NEW_REFRESH = 'renewed-refresh-token-value-not-a-real-toke';
const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';

interface Recorded {
  readonly calls: string[];
  readonly refreshTokensSeen: string[];
  readonly accessTokensSeen: string[];
}

interface Doubles {
  readonly refreshFails?: 'refused' | 'unavailable';
  readonly signOutOutcome?: 'signed_out' | 'already_invalid';
  readonly signOutFails?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], refreshTokensSeen: [], accessTokensSeen: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      refreshSession: async (token: string) => {
        recorded.calls.push('refresh');
        recorded.refreshTokensSeen.push(token);
        if (doubles.refreshFails === 'refused') throw new InvalidCredentialsError();
        if (doubles.refreshFails === 'unavailable') {
          throw new AuthProviderUnavailableError(new Error('provider status 502'));
        }
        return {
          userId: '11111111-1111-4111-8111-111111111111',
          accessToken: NEW_ACCESS,
          refreshToken: NEW_REFRESH,
          expiresIn: 900,
        };
      },
      signOut: async (token: string) => {
        recorded.calls.push('sign-out');
        recorded.accessTokensSeen.push(token);
        if (doubles.signOutFails === true) {
          throw new AuthProviderUnavailableError(new Error('provider status 502'));
        }
        return doubles.signOutOutcome ?? 'signed_out';
      },
      revokeAllSessions: async () => {
        // Deliberately fatal: a sign-out that reached this call would have signed the person out of
        // every device they own. The assertion belongs here rather than in a spy, so it fails loudly
        // wherever it happens.
        recorded.calls.push('revoke-all-sessions');
        throw new Error('a logout must never revoke every session');
      },
      signInWithPassword: async () => {
        throw new Error('a session operation must never sign anyone in');
      },
      updatePassword: async () => {
        throw new Error('a session operation must never change a password');
      },
      getUser: async () => ({ id: '11111111-1111-4111-8111-111111111111', phone: null }),
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
  readonly raw: string;
}

async function post(path: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: path,
    headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, ...headers },
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /v1/auth/refresh', () => {
  it('renews the session from the refresh token the BFF presents', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('ok');
    expect(recorded.calls).toEqual(['refresh']);
    expect(recorded.refreshTokensSeen).toEqual([REFRESH_TOKEN]);
  });

  it('rotates both tokens: the envelope carries new values, not the spent one', async () => {
    await start();
    const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });

    const session = result.body['session'] as Record<string, unknown>;
    expect(session['accessToken']).toBe(NEW_ACCESS);
    expect(session['refreshToken']).toBe(NEW_REFRESH);
    expect(session['refreshToken']).not.toBe(REFRESH_TOKEN);
    expect(session['expiresIn']).toBe(900);
  });

  it('refuses a request with no refresh token without asking the provider', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/refresh');

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('refuses an empty refresh token the same way', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: '' });

    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });

  it('will not accept an access token in place of a refresh token', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/refresh', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('answers an invalid, expired or reused token with one indistinguishable refusal', async () => {
    // The provider stub raises the same error for all three, which is the point: this route has no way
    // to tell them apart and therefore no way to leak which one happened.
    await start({ refreshFails: 'refused' });
    const bodies: string[] = [];
    for (const token of ['expired-token-value', 'reused-token-value', 'nonsense-token-value']) {
      const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: token });
      expect(result.status).toBe(401);
      expect(result.body['code']).toBe('AUTHENTICATION_FAILED');
      bodies.push(JSON.stringify({ ...result.body, instance: undefined }));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('reports an unreachable provider as 503, never as an ended session', async () => {
    await start({ refreshFails: 'unavailable' });
    const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('never echoes the token it was given', async () => {
    await start();
    const result = await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });
    expect(result.raw).not.toContain(REFRESH_TOKEN);
  });

  it('requires the internal BFF credential like every other /v1 route', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /v1/auth/logout', () => {
  it('ends the caller’s own session', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
    expect(recorded.calls).toEqual(['sign-out']);
    expect(recorded.accessTokensSeen).toEqual([ACCESS_TOKEN]);
  });

  it('never revokes the account’s other sessions', async () => {
    const recorded = await start();
    await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(recorded.calls).not.toContain('revoke-all-sessions');
  });

  it('is idempotent: a token the provider no longer holds is still a successful logout', async () => {
    await start({ signOutOutcome: 'already_invalid' });
    const first = await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    const second = await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(second.body);
  });

  it('refuses a request with no session without asking the provider', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/logout');

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('will not accept a refresh token in place of an access token', async () => {
    const recorded = await start();
    const result = await post('/v1/auth/logout', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });

    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });

  it('reports an unreachable provider as 503', async () => {
    await start({ signOutFails: true });
    const result = await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(result.status).toBe(503);
  });

  it('requires the internal BFF credential', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the F2 login route is untouched', () => {
  it('still refuses a malformed body with a validation failure, not a session error', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      },
      payload: JSON.stringify({ identifier: '' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('and no session route can sign anybody in', async () => {
    const recorded = await start();
    await post('/v1/auth/refresh', { [REFRESH_TOKEN_HEADER]: REFRESH_TOKEN });
    await post('/v1/auth/logout', { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(recorded.calls).toEqual(['refresh', 'sign-out']);
  });
});
