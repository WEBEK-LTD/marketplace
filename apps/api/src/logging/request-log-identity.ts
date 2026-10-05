import { runInLogIdentityScope } from '@repo/telemetry';
import type { FastifyInstance } from 'fastify';

/**
 * Opens one log-identity scope per request (C-13, O8-12).
 *
 * The scope starts empty and stays empty for an anonymous request, which is what makes the absence of
 * `user_pseudo_id` meaningful: the field appears only once a handler has actually resolved a user, and
 * never as a placeholder that could be read as an identity.
 *
 * Registered before request tracing so that every later hook, the handler, the error path and the
 * response log all run inside it. The pattern is the same one `registerRequestTracing` uses to keep the
 * request span active: enter the context, then continue the lifecycle from inside it.
 */
export function registerRequestLogIdentity(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (_request, _reply, done) => {
    runInLogIdentityScope(() => {
      done();
    });
  });
}
