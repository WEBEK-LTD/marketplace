import { initTelemetry } from '@repo/telemetry';
import { createSpanRecorder } from '@repo/telemetry/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';
import { INTERNAL_DETAIL_MARKER } from './support/probe.module.js';

const recorder = createSpanRecorder();
initTelemetry({ serviceName: 'api', testSpanProcessor: recorder.processor });

const INCOMING_TRACE_ID = '11111111111111111111111111111111';
const CANARY = {
  authorization: 'Bearer canary-authorization-token',
  cookie: 'sid=canary-cookie-session',
  query: 'canary-query-email@example.test',
  body: 'canary-request-body-secret',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});
beforeEach(() => {
  recorder.reset();
  t.lines.length = 0;
});

const inject = (options: Parameters<TestApp['app']['inject']>[0]) => t.app.inject(options);

describe('API request tracing (O8-10)', () => {
  it('records one root span per request with allowlisted attributes only', async () => {
    const res = await inject({
      method: 'GET',
      url: `/health?email=${CANARY.query}`,
      headers: {
        authorization: CANARY.authorization,
        cookie: CANARY.cookie,
        traceparent: `00-${INCOMING_TRACE_ID}-2222222222222222-01`,
      },
    });
    expect(res.statusCode).toBe(200);
    const spans = recorder.spans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe('GET /health');
    expect(span?.attributes).toEqual({ 'http.request.method': 'GET', 'http.route': '/health', 'http.response.status_code': 200 });
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.spanContext().traceId).not.toBe(INCOMING_TRACE_ID);
    expect(span?.resource.attributes).toEqual({ 'service.name': 'api' });
    const dump = recorder.dump();
    for (const canary of Object.values(CANARY)) expect(dump).not.toContain(canary.replace('Bearer ', ''));
    expect(dump).not.toContain(INCOMING_TRACE_ID);
  });

  it('uses the route template, never the raw path, and never the request body', async () => {
    const res = await inject({ method: 'POST', url: '/probe/echo?x=1', payload: { name: 'n', payload: CANARY.body } });
    expect(res.statusCode).toBe(201);
    const [span] = recorder.spans();
    expect(span?.name).toBe('POST /probe/echo');
    expect(recorder.dump()).not.toContain(CANARY.body);
  });

  it('names unmatched requests without their path', async () => {
    const res = await inject({ method: 'GET', url: '/no/such/path/canary-path-segment?q=1' });
    expect(res.statusCode).toBe(404);
    const [span] = recorder.spans();
    expect(span?.attributes['http.response.status_code']).toBe(404);
    expect(recorder.dump()).not.toContain('canary-path-segment');
  });

  it('marks server errors with the error type only', async () => {
    const res = await inject({ method: 'GET', url: '/probe/boom' });
    expect(res.statusCode).toBe(500);
    const [span] = recorder.spans();
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['error.type']).toBe('Error');
    expect(recorder.dump()).not.toContain(INTERNAL_DETAIL_MARKER);
  });
});

describe('API log correlation (O8-12)', () => {
  it('adds the request span IDs and a module to log lines written during the request', async () => {
    await inject({ method: 'POST', url: '/probe/log-headers', headers: { authorization: CANARY.authorization, cookie: CANARY.cookie }, payload: {} });
    const [span] = recorder.spans();
    const traceId = span?.spanContext().traceId;
    const probe = t.logs().find((line) => line.msg === 'probe headers');
    expect(probe).toMatchObject({ traceId, spanId: span?.spanContext().spanId, module: 'http' });
    const completed = t.logs().find((line) => line.msg === 'request completed');
    expect(completed).toMatchObject({ traceId, module: 'http' });
    // Existing redaction still applies.
    const all = t.lines.join('\n');
    expect(all).not.toContain('canary-authorization-token');
    expect(all).not.toContain('canary-cookie-session');
  });

  it('keeps an explicit module and omits trace fields outside a request', () => {
    const fastify = t.app.getHttpAdapter().getInstance();
    fastify.log.info({ module: 'config', event: 'probe' }, 'outside');
    fastify.log.child({ module: 'custom' }).info('child');
    const outside = t.logs().find((line) => line.msg === 'outside');
    expect(outside).toMatchObject({ module: 'config' });
    expect(outside).not.toHaveProperty('traceId');
    const child = t.lines.find((line) => line.includes('"child"')) ?? '';
    expect(child.match(/"module"/g)).toHaveLength(1);
    expect(JSON.parse(child)).toMatchObject({ module: 'custom' });
  });

  it('labels NestJS framework logs with the nest module', async () => {
    const { NestJsonLogger } = await import('../src/logging/nest-logger.js');
    new NestJsonLogger(t.app.getHttpAdapter().getInstance().log).log('framework message', 'RoutesResolver');
    expect(t.logs().find((line) => line.msg === 'framework message')).toMatchObject({ module: 'nest', context: 'RoutesResolver' });
  });
});
