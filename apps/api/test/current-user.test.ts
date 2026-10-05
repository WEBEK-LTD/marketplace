import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/users/me` (Phase 5-A).
 *
 * The route exists so a signed-in surface can render a name. Everything asserted here is about what it
 * refuses to add to that: no contact details, no verification state, no role, and no way at all to ask
 * about somebody else's account — the account is the token's, and the token is the caller's.
 *
 * The order of the two hops matters too, and is asserted: the provider says whose token it is before the
 * database is asked anything, so a rejected token never reaches a reader.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

interface Recorded {
  readonly calls: string[];
  readonly idsRead: string[];
  readonly tokensSeen: string[];
}

interface Doubles {
  readonly getUserFails?: 'unauthenticated' | 'unavailable';
  readonly identity?: { id: string; displayName: string | null } | null;
  readonly readerThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], idsRead: [], tokensSeen: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (token: string) => {
        recorded.calls.push('get-user');
        recorded.tokensSeen.push(token);
        if (doubles.getUserFails === 'unauthenticated') throw new AuthenticationRequiredError();
        if (doubles.getUserFails === 'unavailable') throw new Error('provider unavailable');
        return { id: USER, phone: '+201000000001' };
      },
      signInWithPassword: async () => {
        throw new Error('reading an identity must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading an identity must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({
      userIdentity: async (userId: string) => {
        recorded.calls.push('user-identity');
        recorded.idsRead.push(userId);
        if (doubles.readerThrows === true) throw new Error('database unavailable');
        return doubles.identity === undefined ? { id: USER, displayName: 'Nadia' } : doubles.identity;
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
  readonly raw: string;
}

async function get(headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'GET',
    url: '/v1/users/me',
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

describe('GET /v1/users/me', () => {
  it('returns the caller’s id and display name', async () => {
    await start();
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user: { id: USER, displayName: 'Nadia' } });
  });

  it('returns those two fields and nothing else', async () => {
    await start();
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    const user = result.body['user'] as Record<string, unknown>;

    expect(Object.keys(result.body)).toEqual(['user']);
    expect(Object.keys(user).sort()).toEqual(['displayName', 'id']);
  });

  it('never returns the contact details the provider handed it', async () => {
    await start();
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(result.raw).not.toContain('+201000000001');
    expect(result.raw).not.toContain('phone');
    expect(result.raw).not.toContain('email');
  });

  it('never echoes the caller’s token', async () => {
    await start();
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(result.raw).not.toContain(ACCESS_TOKEN);
  });

  it('reads the account the provider named, never one from the request', async () => {
    const recorded = await start();
    // The header is a lie a caller could tell; the account still comes from the token.
    await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN, 'x-user-id': OTHER_USER });

    expect(recorded.idsRead).toEqual([USER]);
    expect(recorded.idsRead).not.toContain(OTHER_USER);
  });

  it('asks the provider before it asks the database', async () => {
    const recorded = await start();
    await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });
    expect(recorded.calls).toEqual(['get-user', 'user-identity']);
  });

  it('renders a null display name rather than inventing one', async () => {
    await start({ identity: { id: USER, displayName: null } });
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user: { id: USER, displayName: null } });
  });

  it('refuses a request with no session without asking anything', async () => {
    const recorded = await start();
    const result = await get();

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('refuses an empty session header the same way', async () => {
    const recorded = await start();
    const result = await get({ [SESSION_TOKEN_HEADER]: '' });

    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a token the provider does not accept, without reaching the database', async () => {
    const recorded = await start({ getUserFails: 'unauthenticated' });
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual(['get-user']);
  });

  it('treats a deleted or missing profile as no usable session', async () => {
    await start({ identity: null });
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
  });

  it('reports an unreadable database as 503, never as a sign-out', async () => {
    await start({ readerThrows: true });
    const result = await get({ [SESSION_TOKEN_HEADER]: ACCESS_TOKEN });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('requires the internal BFF credential', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('exposes no route that names an account', async () => {
    await start();
    const fastify = app!.getHttpAdapter().getInstance();
    for (const url of ['/v1/users/:id', '/v1/users/:userId', '/v1/users']) {
      expect(fastify.hasRoute({ method: 'GET', url }), url).toBe(false);
    }
  });
});
