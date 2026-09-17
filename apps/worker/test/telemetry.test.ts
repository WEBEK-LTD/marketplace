import { initTelemetry } from '@repo/telemetry';
import { createSpanRecorder } from '@repo/telemetry/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueueDefinition } from '../src/queue/definitions.js';
import { createProducer } from '../src/queue/producer.js';
import { startRedis, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, inspector, waitUntil, type TestRuntime } from './support/runtime.js';

const recorder = createSpanRecorder();
initTelemetry({ serviceName: 'worker', testSpanProcessor: recorder.processor });

const CANARY_ID = 'cafecafe-0000-4000-8000-00000000c0de';
const CANARY_ERROR = 'canary-worker-error-message';

let server: RedisInstance;
const runtimes: TestRuntime[] = [];
beforeAll(async () => {
  server = await startRedis();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => recorder.reset());
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((t) => t.runtime.stop()));
});

async function run(definition: QueueDefinition): Promise<TestRuntime> {
  const t = await createTestRuntime(server.url, [definition], { random: () => 1 });
  runtimes.push(t);
  await t.runtime.start();
  return t;
}

describe('worker job tracing (O8-8)', () => {
  it('records one root span per attempt with queue, job name and attempt only', async () => {
    let calls = 0;
    const t: TestRuntime = await run({
      name: 'otel-jobs',
      process: async () => {
        calls += 1;
        t.logger.info({ event: 'inside_job' }, 'inside job');
        if (calls < 3) throw new TypeError(CANARY_ERROR);
      },
    });
    const producer = createProducer('otel-jobs', inspector(server.url));
    const jobId = await producer.enqueue('probe-job', { orderId: CANARY_ID });
    await waitUntil(async () => (await producer.queue.getJobState(jobId)) === 'completed', 20_000);
    await waitUntil(() => recorder.spans().length === 3);
    const spans = recorder.spans();
    expect(spans.map((span) => span.name)).toEqual(['process otel-jobs', 'process otel-jobs', 'process otel-jobs']);
    expect(spans.map((span) => span.attributes['job.attempt'])).toEqual([1, 2, 3]);
    for (const span of spans) {
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.resource.attributes).toEqual({ 'service.name': 'worker' });
    }
    expect(spans[0]?.attributes).toEqual({ 'queue.name': 'otel-jobs', 'job.name': 'probe-job', 'job.attempt': 1, 'error.type': 'TypeError' });
    expect(spans[0]?.status.code).toBe(2);
    expect(spans[2]?.attributes).toEqual({ 'queue.name': 'otel-jobs', 'job.name': 'probe-job', 'job.attempt': 3 });
    const dump = recorder.dump();
    expect(dump).not.toContain(CANARY_ID);
    expect(dump).not.toContain(CANARY_ERROR);
    expect(dump).not.toContain(jobId === '' ? 'never' : `"${jobId}"`);

    // Log lines written inside the job carry that attempt's span IDs.
    const inside = t.logs().filter((line) => line.event === 'inside_job');
    expect(inside.map((line) => line.traceId)).toEqual(spans.map((span) => span.spanContext().traceId));
    expect(inside[0]).toMatchObject({ module: 'runtime', spanId: spans[0]?.spanContext().spanId });
    await producer.close();
  });

  it('labels log lines with their module and adds no trace fields outside jobs', async () => {
    const t = await run({ name: 'otel-modules', process: async () => undefined });
    const logs = t.logs();
    expect(logs.find((line) => line.event === 'redis_ready')).toMatchObject({ module: 'redis' });
    expect(logs.find((line) => line.event === 'worker_started')).toMatchObject({ module: 'runtime' });
    for (const line of logs) expect(line).not.toHaveProperty('traceId');
    for (const raw of t.lines) expect(raw.match(/"module"/g)).toHaveLength(1);
  });

  it('dead-letter alerts are logged by the queue module', async () => {
    const t = await createTestRuntime(server.url, [{ name: 'otel-dlq', process: async () => undefined }]);
    runtimes.push(t);
    await t.runtime.start();
    const raw = createProducer('otel-dlq', inspector(server.url));
    await raw.queue.add('bad', { note: 'not ids' });
    await waitUntil(() => t.logs().some((line) => line.event === 'dead_letter'), 20_000);
    expect(t.logs().find((line) => line.event === 'dead_letter')).toMatchObject({ module: 'queue' });
    await raw.close();
  });
});
