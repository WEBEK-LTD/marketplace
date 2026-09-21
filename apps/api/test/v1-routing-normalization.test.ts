import 'reflect-metadata';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { FoundationController } from '../src/v1/foundation.controller.js';
import { INTERNAL_CREDENTIAL_HEADER, isProtectedRoutePattern } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The security property under test:
 *
 *   > No request that Fastify resolves to a `/v1` route may execute that route without the internal
 *   > credential.
 *
 * This is deliberately an end-to-end test over a real socket. The bypass it guards against was a
 * disagreement between Fastify's router and the guard about what the path was, and no unit test of
 * either side alone can see that disagreement. Requests are therefore written with `node:http`, whose
 * `path` is sent verbatim, rather than through a client that might normalize percent-encoding and make
 * the test vacuously pass.
 *
 * "Did not reach the handler" is proved by a spy on the controller method, not by reading a status
 * code. The spy is installed on the prototype before the application is built, so NestJS binds the
 * spied function when it wires the route; a control case asserts the spy does fire on a legitimate
 * request, without which "never called" would prove nothing.
 */

/** Percent-encodings of `/v1/foundation` that Fastify's router resolves to the registered route. */
const ENCODED_V1_PATHS = ['/%76%31/foundation', '/v%31/foundation', '/%761/foundation'] as const;

/** Paths that look like `/v1` but are not the registered route, so no route matches at all. */
const UNMATCHED_PATHS = [
  '/V1/foundation',
  '/v1x/foundation',
  '/v10/foundation',
  '//v1/foundation',
  '/v1/foundation/',
  '/v1/../v1/foundation',
] as const;

interface Observed {
  readonly url: string;
  readonly routePattern: string | undefined;
}

interface Response {
  readonly status: number;
  readonly body: string;
}

let app: NestFastifyApplication;
let port: number;
let handler: ReturnType<typeof vi.spyOn>;
/** What the server saw, per request, recorded before the handler runs. */
let observed: Observed[];

function get(path: string, credential?: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        // Sent byte-for-byte: no client-side normalization of the encoded paths under test.
        path,
        headers: credential === undefined ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  // Installed before the module is compiled so that NestJS binds the spy, not the original. NestJS
  // keeps `@Get('foundation')`'s routing metadata on the method function itself, so it is carried over
  // to the replacement — otherwise the route would silently stop being registered and every assertion
  // below would pass against a 404 instead of against the guard.
  const original = FoundationController.prototype.foundation;
  handler = vi.spyOn(FoundationController.prototype, 'foundation');
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), FoundationController.prototype.foundation);
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);

  observed = [];
  // Observation only: this hook records what the router resolved and changes no routing behaviour.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('preHandler', async (request) => {
      observed.push({ url: request.url, routePattern: request.routeOptions?.url });
    });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.getHttpServer().address() as AddressInfo).port;
});

afterAll(async () => {
  handler.mockRestore();
  await app.close();
});

beforeEach(() => {
  handler.mockClear();
  observed.length = 0;
});

describe('routing normalization cannot bypass the /v1 credential boundary', () => {
  it('is a meaningful witness: a legitimate call does execute the handler', async () => {
    const res = await get('/v1/foundation', TEST_INTERNAL_CREDENTIAL);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses the plain path without a credential', async () => {
    const res = await get('/v1/foundation');
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(ENCODED_V1_PATHS)(
    'refuses %s without a credential and never executes the handler',
    async (path) => {
      const res = await get(path);

      // The request really did arrive percent-encoded, so this case is not passing vacuously.
      expect(observed[0]?.url).toBe(path);
      // ...and Fastify really did resolve it to the protected route.
      expect(observed[0]?.routePattern).toBe('/v1/foundation');

      expect(handler).not.toHaveBeenCalled();
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ status: 403, code: 'HTTP_ERROR' });
      expect(res.body).not.toContain('"ok"');
    },
  );

  it.each(ENCODED_V1_PATHS)('serves %s normally once the credential is presented', async (path) => {
    const res = await get(path, TEST_INTERNAL_CREDENTIAL);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses the plain path with a query string and no credential', async () => {
    const res = await get('/v1/foundation?x=1');
    expect(observed[0]?.routePattern).toBe('/v1/foundation');
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(UNMATCHED_PATHS)('matches no route for %s, so the handler never runs', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    // No route matched, so there is no pattern to protect — which is why the guard fails closed
    // rather than treating "unknown" as "outside /v1".
    expect(observed[0]?.routePattern).toBeUndefined();
  });

  it('leaves /health and /ready public', async () => {
    for (const path of ['/health', '/ready']) {
      expect((await get(path)).status, path).toBe(200);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the guard and the router agree on the matched route', () => {
  it.each(['/v1/foundation', ...ENCODED_V1_PATHS])(
    'resolves %s to /v1/foundation, which the guard classifies as protected',
    async (path) => {
      await get(path, TEST_INTERNAL_CREDENTIAL);

      const seen = observed[0];
      expect(seen?.url).toBe(path);
      // The single fact the fix rests on: whatever the caller wrote, the router reports the registered
      // pattern, and the guard's predicate is applied to exactly that.
      expect(seen?.routePattern).toBe('/v1/foundation');
      expect(isProtectedRoutePattern(seen?.routePattern)).toBe(true);
    },
  );

  it('reports the public patterns for /health and /ready, which the guard classifies as open', async () => {
    for (const path of ['/health', '/ready']) {
      observed.length = 0;
      await get(path);
      expect(observed[0]?.routePattern, path).toBe(path);
      expect(isProtectedRoutePattern(observed[0]?.routePattern), path).toBe(false);
    }
  });
});
