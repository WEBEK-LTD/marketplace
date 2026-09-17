import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trace } from '@repo/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../src/instrumentation';
import { APP_DIR } from './support/next-server.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('admin instrumentation telemetry (O8-11)', () => {
  it('does nothing outside the Node.js runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    const span = trace.getTracer('probe').startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  it('registers the tracer provider after validating the configuration in the Node.js runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_BASE_URL', 'http://127.0.0.1:9');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await register();
    const span = trace.getTracer('probe').startSpan('probe');
    expect(span.isRecording()).toBe(true);
    span.end();
  });

  it('keeps OpenTelemetry out of the client bundles', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? files(full) : [full];
      });
    const text = files(join(APP_DIR, '.next/static'))
      .map((file) => readFileSync(file, 'latin1'))
      .join('\n');
    expect(text.length).toBeGreaterThan(0);
    // Code markers of OpenTelemetry and @repo/telemetry. (The pnpm folder name of Next.js, which
    // contains "@opentelemetry+api" as a peer suffix, is a path string, not code.)
    const markers = /opentelemetry\.js\.api|@opentelemetry\/[a-z-]+|TracerProvider|SanitizingSpanProcessor|ALLOWED_SPAN_ATTRIBUTES|activeTraceFields/g;
    expect([...new Set(text.match(markers) ?? [])]).toEqual([]);
    // Negative control: the same markers are found in the server bundle.
    const server = files(join(APP_DIR, '.next/server'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'latin1'))
      .join('\n');
    expect(server.match(markers)?.length ?? 0).toBeGreaterThan(0);
  });
});
