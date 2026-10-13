/**
 * The API, as one Netlify Function (increment 0117).
 *
 * **Why this exists.** The owner's deployment decision is Netlify and Supabase and nothing else, so the
 * NestJS API has no long-running host to live on. It runs here instead: one function, mounted at `/_api/*`
 * by the redirect in `netlify.toml`, serving exactly the routes it serves anywhere else.
 *
 * **The application is unchanged.** This file calls `createApp` — the same factory `main.ts` calls and the
 * same one every API test drives — and configures nothing of its own. Every guard, pipe, filter, header and
 * authorization check is the one that was already there, because this is a different way to *invoke* the
 * application rather than a different application.
 *
 * **It boots once and is reused.** Netlify keeps a warm instance between invocations, so the Nest container,
 * the Kysely instance and the PostgreSQL pool are built on the first request and reused by the rest. A boot
 * per request would open a connection pool per request, which is the quickest way to exhaust a database.
 *
 * **The pool must be small, and that is configuration rather than code.** Each warm instance holds its own
 * pool, and many instances can exist at once, so `APP_SYSTEM_DATABASE_MAX_CONNECTIONS` is set to 1 and
 * `APP_SYSTEM_DATABASE_URL` points at Supabase's transaction-mode pooler. `@repo/db` already notes why that
 * is safe: node-postgres sends parameterised queries as unnamed statements, so no named prepared statement
 * ever reaches the pooler.
 *
 * **Requests are injected, not socketed.** `app.inject()` hands Fastify a request object directly and gets
 * the reply back, with no listening port and no loopback connection. It is the same path the API's own test
 * suite uses, which is to say the path this application's behaviour is actually proven on.
 *
 * **Nothing here decides who may call it.** `/_api/*` is reachable from the internet, and that changes no
 * authorization: `InternalCredentialGuard` is registered as an `APP_GUARD` over every route and refuses any
 * request without the internal credential, which only the BFF holds. That guard was the boundary before this
 * file existed and it is the boundary now.
 */
import type { Context } from '@netlify/functions';
import { createApp } from '../../apps/api/dist/app.factory.js';
import { loadEnv } from '../../apps/api/dist/config/env.js';
import {
  applicationPath,
  bootFailureBody,
  carriesBody,
  replyHeaders,
} from '../../apps/api/dist/netlify-bridge.js';

/** Built on the first request of a warm instance and reused by every request after it. */
let started: Promise<Awaited<ReturnType<typeof createApp>>> | null = null;

function app(): Promise<Awaited<ReturnType<typeof createApp>>> {
  if (started === null) {
    started = (async () => {
      const instance = await createApp(loadEnv());
      // `init` without `listen`: the Fastify instance is built and ready to be injected into, and no socket
      // is opened — there is nothing to listen on in a function.
      await instance.init();
      return instance;
    })().catch((error: unknown) => {
      // A failed boot must not be cached as a resolved promise: the next invocation should try again rather
      // than serve a broken instance for the life of the container.
      started = null;
      throw error;
    });
  }
  return started;
}

export default async function handler(request: Request, _context: Context): Promise<Response> {
  const url = new URL(request.url);
  const path = applicationPath(url.pathname);

  let instance: Awaited<ReturnType<typeof createApp>>;
  try {
    instance = await app();
  } catch {
    // The message is deliberately empty of detail: a boot failure is almost always a configuration
    // problem, and the names of the variables involved belong in the function log, not in a response.
    return new Response(bootFailureBody(path), {
      status: 503,
      headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    });
  }

  const body = carriesBody(request.method) ? Buffer.from(await request.arrayBuffer()) : undefined;

  const reply = await instance.getHttpAdapter().getInstance().inject({
    method: request.method as 'GET',
    url: `${path}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
    ...(body === undefined || body.length === 0 ? {} : { payload: body }),
  });

  // `rawPayload` rather than `payload`: a response may be any content type, and decoding it as text would
  // corrupt anything that is not.
  return new Response(reply.rawPayload, {
    status: reply.statusCode,
    headers: replyHeaders(reply.headers as Record<string, unknown>),
  });
}
