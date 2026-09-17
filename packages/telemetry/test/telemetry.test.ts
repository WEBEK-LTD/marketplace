import { beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { activeTraceFields, initTelemetry, type Telemetry } from '../src/index.js';
import { createSpanRecorder } from '../src/testing.js';

const recorder = createSpanRecorder();
let telemetry: Telemetry;
beforeAll(() => {
  telemetry = initTelemetry({ serviceName: 'api', testSpanProcessor: recorder.processor });
});

const CANARIES = [
  'canary-secret-authorization-value',
  'canary-cookie-session',
  'canary-query-email@example.test',
  'canary-claim-subject',
  'select canary_sql from secrets',
  'canary-sql-parameter',
  'canary-job-payload',
  'canary-error-message',
  'canary-redis-command',
];

describe('telemetry provider', () => {
  it('is registered once per service', () => {
    expect(initTelemetry({ serviceName: 'api' })).toBe(telemetry);
    expect(() => initTelemetry({ serviceName: 'worker' })).toThrow(/another service/);
  });

  it('records spans with service.name only as resource and AlwaysOn sampling', () => {
    recorder.reset();
    telemetry.tracer.startSpan('probe').end();
    const [span] = recorder.spans();
    expect(span?.resource.attributes).toEqual({ 'service.name': 'api' });
    expect(span?.spanContext().traceFlags).toBe(1);
  });

  it('ignores incoming trace context (no propagator)', () => {
    const incoming = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
    const extracted = propagation.extract(context.active(), incoming);
    expect(trace.getSpanContext(extracted)).toBeUndefined();
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    expect(carrier).toEqual({});
  });

  it('exposes trace fields for logs only inside an active span', () => {
    expect(activeTraceFields()).toEqual({});
    telemetry.tracer.startActiveSpan('active', (span) => {
      expect(activeTraceFields()).toEqual({ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId });
      span.end();
    });
    expect(activeTraceFields()).toEqual({});
  });
});

describe('strict allowlist (O8-13) with canary values', () => {
  it('drops everything that is not allowlisted and strips URLs to their path', () => {
    recorder.reset();
    const span = telemetry.tracer.startSpan('GET /items?email=canary-query-email@example.test', {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/items/:id',
        'http.response.status_code': 500,
        'http.url': 'https://user:canary-secret-authorization-value@web.example/items/1?email=canary-query-email@example.test#frag',
        'http.target': '/items/1?email=canary-query-email@example.test',
        'http.request.header.authorization': 'Bearer canary-secret-authorization-value',
        'http.request.header.cookie': 'sid=canary-cookie-session',
        'enduser.id': 'canary-claim-subject',
        'db.statement': 'select canary_sql from secrets',
        'db.query.text': 'select canary_sql from secrets',
        'db.query.parameter.0': 'canary-sql-parameter',
        'db.redis.command': 'canary-redis-command',
        'messaging.message.body': 'canary-job-payload',
        'job.data': 'canary-job-payload',
        'queue.name': 'emails',
        'job.name': 'send',
        'job.attempt': 2,
        'db.system': 'postgresql',
        'error.type': 'TypeError',
      },
    });
    span.addEvent('log', { message: 'canary-error-message' });
    span.recordException(new TypeError('canary-error-message'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'canary-error-message' });
    span.addLink({ context: span.spanContext(), attributes: { claim: 'canary-claim-subject' } });
    span.end();

    const [out] = recorder.spans() as [ReadableSpan];
    expect(out.name).toBe('GET /items');
    expect(out.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/items/:id',
      'http.response.status_code': 500,
      'http.url': '/items/1',
      'http.target': '/items/1',
      'queue.name': 'emails',
      'job.name': 'send',
      'job.attempt': 2,
      'db.system': 'postgresql',
      'error.type': 'TypeError',
    });
    expect(out.events.map((e) => [e.name, e.attributes])).toEqual([['exception', { 'exception.type': 'TypeError' }]]);
    expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(out.links[0]?.attributes).toBeUndefined();
    const dump = recorder.dump();
    for (const canary of CANARIES) expect(dump).not.toContain(canary);
  });

  it('negative control: the same canaries are visible on the live, unsanitised span', () => {
    const live = telemetry.tracer.startSpan('control', { attributes: { 'http.request.header.cookie': 'sid=canary-cookie-session' } }) as unknown as ReadableSpan & { end(): void };
    expect(JSON.stringify(live.attributes)).toContain('canary-cookie-session');
    live.end();
  });
});

describe('shutdown', () => {
  it('never waits longer than the timeout', async () => {
    const started = Date.now();
    await telemetry.shutdown(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
