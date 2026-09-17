import { context, SpanKind, SpanStatusCode, trace, type Span } from '@repo/telemetry';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const spans = new WeakMap<FastifyRequest, Span>();
const UNMATCHED_ROUTE = 'unmatched route';

function endSpan(request: FastifyRequest, statusCode?: number): void {
  const span = spans.get(request);
  if (span === undefined) return;
  spans.delete(request);
  if (statusCode !== undefined) {
    span.setAttribute('http.response.status_code', statusCode);
    if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

/**
 * Explicit request tracing (owner decisions O8-2, O8-7, O8-10). Each request starts a new root span
 * (incoming trace context is ignored) named after the route template. Only the method, route template
 * and status code are recorded; never the raw URL, query string, headers, cookies or body.
 */
export function registerRequestTracing(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    const route = request.routeOptions.url;
    const span = trace.getTracer('api').startSpan(`${request.method} ${route ?? UNMATCHED_ROUTE}`, {
      kind: SpanKind.SERVER,
      root: true,
      attributes: { 'http.request.method': request.method, ...(route === undefined ? {} : { 'http.route': route }) },
    });
    spans.set(request, span);
    // The rest of the request lifecycle runs with this span active, so log lines carry its IDs.
    context.with(trace.setSpan(context.active(), span), done);
  });
  fastify.addHook('onError', (request, _reply, error, done) => {
    spans.get(request)?.setAttribute('error.type', error.name);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    endSpan(request, reply.statusCode);
    done();
  });
  fastify.addHook('onRequestAbort', (request, done) => {
    endSpan(request);
    done();
  });
}
