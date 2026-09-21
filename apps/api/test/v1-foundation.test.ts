import { readFileSync } from 'node:fs';
import { ForbiddenException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ProblemDetailsSchema, V1FoundationResponseSchema } from '@repo/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { loadEnv } from '../src/config/env.js';
import {
  INTERNAL_CREDENTIAL_HEADER,
  InternalCredentialGuard,
  isProtectedRoutePattern,
} from '../src/v1/internal-credential.guard.js';
import { createTestApp, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

const CURRENT = TEST_INTERNAL_CREDENTIAL;
const PREVIOUS = 'test-previous-credential-value-not-a-real-s';
/** Same length as a real credential, so a length check alone could not reject it. */
const WRONG_SAME_LENGTH = 'test-wrong-credential-value-not-a-real-secx';
const MALFORMED = 'not-base64url!!';

const baseEnv = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  LOG_LEVEL: 'info',
  APP_SYSTEM_DATABASE_URL: 'postgresql://app_system@db.invalid:5432/marketplace',
  OTP_PEPPER: 'test-otp-pepper-value-not-a-real-secret-0123456789',
  WAABEK_BASE_URL: 'https://waabek.invalid',
  WAABEK_API_KEY: 'test-waabek-key-not-a-real-secret',
};

/** An app whose accepted credential list is exactly `credential` (may be "CURRENT,PREVIOUS"). */
async function appWith(credential: string): Promise<NestFastifyApplication> {
  const env = loadEnv({ ...baseEnv, INTERNAL_BFF_CREDENTIAL: credential });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(env, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('the /v1 boundary', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await appWith(CURRENT);
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (credential?: string) => {
    const req = request(app.getHttpServer()).get('/v1/foundation');
    return credential === undefined ? req : req.set(INTERNAL_CREDENTIAL_HEADER, credential);
  };

  // A — correct credential succeeds
  it('accepts the correct credential', async () => {
    const res = await get(CURRENT);
    expect(res.status).toBe(200);
    expect(V1FoundationResponseSchema.parse(JSON.parse(res.text))).toEqual({ status: 'ok' });
  });

  // B — missing credential
  it('refuses a missing credential with 403 and a generic problem', async () => {
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    const body = ProblemDetailsSchema.parse(JSON.parse(res.text));
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'HTTP_ERROR',
      detail: 'The request could not be completed.',
      instance: '/v1/foundation',
    });
    // The refusal must not advertise the scheme.
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  // C, D, E — wrong, malformed and same-length-wrong are byte-identical to missing
  it.each([
    ['wrong', WRONG_SAME_LENGTH],
    ['malformed', MALFORMED],
    ['empty', ''],
  ])('refuses a %s credential with exactly the same response as a missing one', async (_label, value) => {
    const missing = await get();
    const presented = await get(value);

    expect(presented.status).toBe(missing.status);
    // Byte-for-byte: status, body and the headers that could carry a hint.
    expect(presented.text).toBe(missing.text);
    expect(presented.headers['content-type']).toBe(missing.headers['content-type']);
    expect(presented.headers['www-authenticate']).toBe(missing.headers['www-authenticate']);
  });

  it('rejects a wrong credential of exactly the right length', async () => {
    expect(WRONG_SAME_LENGTH).toHaveLength(CURRENT.length);
    expect((await get(WRONG_SAME_LENGTH)).status).toBe(403);
  });

  it('rejects a duplicated header, which arrives as an array', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/foundation')
      .set(INTERNAL_CREDENTIAL_HEADER, [CURRENT, CURRENT] as unknown as string);
    expect(res.status).toBe(403);
  });

  // G, H — health and ready are outside /v1
  it('leaves /health and /ready reachable without the credential', async () => {
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/ready')).status).toBe(200);
  });

  // I — the credential authorizes nothing about a user
  it('returns no user context, so the credential cannot stand in for user authorization', async () => {
    const body = JSON.parse((await get(CURRENT)).text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['status']);
    for (const key of ['user', 'userId', 'sub', 'role', 'roles', 'permissions', 'aal', 'session', 'token']) {
      expect(body).not.toHaveProperty(key);
    }
    // The guard must attach nothing that a later handler could mistake for a principal.
    const source = readFileSync(new URL('../src/v1/internal-credential.guard.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/request\.(user|principal|auth)\s*=/);
  });

  // J — the credential never appears in a problem response
  it('never echoes the credential into the problem details', async () => {
    for (const value of [CURRENT, WRONG_SAME_LENGTH, MALFORMED]) {
      const res = await get(value);
      expect(res.text).not.toContain(value);
    }
  });
});

// K — never logged
describe('logging', () => {
  it('never writes the credential to a log line', async () => {
    const t = await createTestApp();
    try {
      await request(t.app.getHttpServer()).get('/v1/foundation').set(INTERNAL_CREDENTIAL_HEADER, CURRENT);
      await request(t.app.getHttpServer()).get('/v1/foundation').set(INTERNAL_CREDENTIAL_HEADER, WRONG_SAME_LENGTH);
      expect(t.lines.length).toBeGreaterThan(0);
      expect(t.lines.join('\n')).not.toContain(CURRENT);
      expect(t.lines.join('\n')).not.toContain(WRONG_SAME_LENGTH);
    } finally {
      await t.app.close();
    }
  });

  it('pins the header in the redaction list', async () => {
    const { REDACTED_PATHS } = await import('../src/logging/logger-options.js');
    expect(REDACTED_PATHS).toContain('req.headers["x-internal-credential"]');
    expect(REDACTED_PATHS).toContain('headers["x-internal-credential"]');
  });
});

// M, N — rotation
describe('rotation', () => {
  let rotating: NestFastifyApplication;
  afterEach(async () => {
    await rotating?.close();
  });

  it('accepts both CURRENT and PREVIOUS while both are configured', async () => {
    rotating = await appWith(`${CURRENT},${PREVIOUS}`);
    for (const value of [CURRENT, PREVIOUS]) {
      const res = await request(rotating.getHttpServer())
        .get('/v1/foundation')
        .set(INTERNAL_CREDENTIAL_HEADER, value);
      expect(res.status, value).toBe(200);
    }
  });

  it('stops accepting the removed value once only CURRENT remains', async () => {
    rotating = await appWith(CURRENT);
    const removed = await request(rotating.getHttpServer())
      .get('/v1/foundation')
      .set(INTERNAL_CREDENTIAL_HEADER, PREVIOUS);
    expect(removed.status).toBe(403);
  });
});

// F — timing-safe comparison, and the path rule
describe('the guard itself', () => {
  it('compares with timingSafeEqual over fixed-width digests, never with ===', () => {
    const source = readFileSync(new URL('../src/v1/internal-credential.guard.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('timingSafeEqual');
    expect(code).toContain('createHash');
    // No direct value comparison and no early exit that would leak which candidate matched.
    expect(code).not.toMatch(/presented\s*===|===\s*presented|accepted\.includes|indexOf\(presented/);
    expect(code).not.toMatch(/return true;\s*\}\s*\}\s*return matched/);
  });

  it('decides scope from registered route patterns, not request URLs', () => {
    // The argument is always a pattern the application registered, so there is no encoding to undo.
    expect(isProtectedRoutePattern('/v1')).toBe(true);
    expect(isProtectedRoutePattern('/v1/foundation')).toBe(true);
    expect(isProtectedRoutePattern('/v1/orders/:id')).toBe(true);
    expect(isProtectedRoutePattern('/health')).toBe(false);
    expect(isProtectedRoutePattern('/ready')).toBe(false);
    expect(isProtectedRoutePattern('/probe/echo')).toBe(false);
  });

  it('fails closed when the matched route cannot be determined', () => {
    expect(isProtectedRoutePattern(undefined)).toBe(true);
    expect(isProtectedRoutePattern('')).toBe(true);
    // Erring wide: a future group registered as /v1x is covered rather than silently exempt.
    expect(isProtectedRoutePattern('/v1x/thing')).toBe(true);
  });

  it('refuses a request whose matched route is unavailable, credential or not', () => {
    // Fastify routing is untouched here: this is the guard's own fail-closed branch, reached by
    // handing it a request that carries no routeOptions at all.
    const guard = new InternalCredentialGuard([CURRENT]);
    const contextFor = (headers: Record<string, unknown>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      }) as unknown as Parameters<InternalCredentialGuard['canActivate']>[0];

    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
    // Even the correct credential cannot make an undetermined route unprotected — it is still checked.
    expect(guard.canActivate(contextFor({ [INTERNAL_CREDENTIAL_HEADER]: CURRENT }))).toBe(true);
    expect(() => guard.canActivate(contextFor({ [INTERNAL_CREDENTIAL_HEADER]: WRONG_SAME_LENGTH }))).toThrow(
      ForbiddenException,
    );
  });

  it('never reads the raw request URL for the boundary decision', () => {
    const source = readFileSync(new URL('../src/v1/internal-credential.guard.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The bypass was `request.url`; re-introducing it, or a hand-rolled decoder, must fail here.
    expect(code).not.toMatch(/request\.url|\.originalUrl|decodeURI|decodeURIComponent|unescape\(/);
    expect(code).toContain('routeOptions');
  });
});
