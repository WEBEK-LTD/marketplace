import { describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';

// Hostile OTEL_* settings before the provider is created (O8-6): they must not change anything.
const HOSTILE = {
  OTEL_SDK_DISABLED: 'true',
  OTEL_TRACES_SAMPLER: 'always_off',
  OTEL_TRACES_SAMPLER_ARG: '0',
  OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '1',
  OTEL_ATTRIBUTE_COUNT_LIMIT: '1',
  OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '2',
  OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '2',
  OTEL_SPAN_EVENT_COUNT_LIMIT: '0',
  OTEL_PROPAGATORS: 'tracecontext,baggage,b3',
  OTEL_SERVICE_NAME: 'canary-env-service',
  OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=canary-env,host.name=canary-host',
  OTEL_TRACES_EXPORTER: 'otlp,console',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://canary-collector.invalid:4318',
};
Object.assign(process.env, HOSTILE);
const { initTelemetry, SPAN_LIMITS } = await import('../src/index.js');
const { createSpanRecorder } = await import('../src/testing.js');

describe('OTEL_* environment variables are ignored (O8-6)', () => {
  const recorder = createSpanRecorder();
  const telemetry = initTelemetry({ serviceName: 'worker', testSpanProcessor: recorder.processor });

  it('keeps AlwaysOn sampling, the explicit limits, service.name and no propagator', () => {
    const span = telemetry.tracer.startSpan('env-probe', { attributes: { 'queue.name': 'emails', 'job.name': 'send', 'job.attempt': 1 } });
    const live = span as unknown as { attributes: Record<string, unknown>; resource: { attributes: Record<string, unknown> } };
    expect(Object.keys(live.attributes)).toHaveLength(3);
    expect(live.attributes['queue.name']).toBe('emails');
    expect(live.resource.attributes).toEqual({ 'service.name': 'worker' });
    span.addEvent('exception', { 'exception.type': 'TypeError' });
    span.end();
    const [out] = recorder.spans();
    expect(out?.spanContext().traceFlags).toBe(1);
    expect(out?.events).toHaveLength(1);
    expect(out?.resource.attributes).toEqual({ 'service.name': 'worker' });
    expect(JSON.stringify(recorder.dump())).not.toMatch(/canary-env|canary-host|canary-collector/);
    expect(SPAN_LIMITS.attributeCountLimit).toBe(32);
    const extracted = propagation.extract(context.active(), { traceparent: '00-11111111111111111111111111111111-2222222222222222-01', b3: '1-2-1' });
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });
});
