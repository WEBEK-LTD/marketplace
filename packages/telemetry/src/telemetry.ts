import { context, trace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  NodeTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { sanitizeSpan } from './sanitize.js';

export type ServiceName = 'api' | 'worker' | 'web' | 'admin';

/** Explicit limits so that OTEL_* environment variables cannot change them (O8-6). */
export const SPAN_LIMITS = Object.freeze({
  attributeCountLimit: 32,
  attributeValueLengthLimit: 256,
  linkCountLimit: 8,
  eventCountLimit: 16,
  attributePerEventCountLimit: 4,
  attributePerLinkCountLimit: 0,
});

/**
 * Passes a sanitised copy of every finished span to the downstream processor. In Phase 1 there is no
 * downstream outside tests (no export, O8-5), so spans are dropped after they end.
 */
export class SanitizingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly serviceName: ServiceName,
    private readonly downstream?: SpanProcessor,
  ) {}

  onStart(_span: Span): void {
    // The downstream never sees the live span.
  }

  onEnd(span: ReadableSpan): void {
    this.downstream?.onEnd(sanitizeSpan(span, this.serviceName));
  }

  forceFlush(): Promise<void> {
    return this.downstream?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.downstream?.shutdown() ?? Promise.resolve();
  }
}

export interface TelemetryOptions {
  readonly serviceName: ServiceName;
  /** Test hook: receives sanitised spans (for example an in-memory exporter's processor). */
  readonly testSpanProcessor?: SpanProcessor;
}

export interface Telemetry {
  readonly serviceName: ServiceName;
  readonly tracer: Tracer;
  /** Ends telemetry within the given time; never waits longer. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
let active: Telemetry | undefined;

/**
 * Registers the process-wide tracer provider once (O8-5, O8-6, O8-7, O8-14, O8-15):
 * AlwaysOn sampling, explicit limits, `service.name` only, no resource detectors, no exporter and
 * no propagator (incoming trace context is never extracted).
 */
export function initTelemetry(options: TelemetryOptions): Telemetry {
  if (active !== undefined) {
    if (active.serviceName !== options.serviceName) throw new Error('Telemetry is already initialised for another service.');
    return active;
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    sampler: new AlwaysOnSampler(),
    spanLimits: { ...SPAN_LIMITS },
    generalLimits: { attributeCountLimit: SPAN_LIMITS.attributeCountLimit, attributeValueLengthLimit: SPAN_LIMITS.attributeValueLengthLimit },
    spanProcessors: [new SanitizingSpanProcessor(options.serviceName, options.testSpanProcessor)],
  });
  provider.register({ propagator: null });
  const telemetry: Telemetry = {
    serviceName: options.serviceName,
    tracer: trace.getTracer(options.serviceName),
    async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      await Promise.race([provider.shutdown().catch(() => undefined), timeout]);
      clearTimeout(timer);
    },
  };
  active = telemetry;
  return telemetry;
}

/** Trace and span IDs of the active span, for log correlation (O8-12). Empty when there is none. */
export function activeTraceFields(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (span === undefined) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  if (!trace.isSpanContextValid(span.spanContext()) || traceFlags === undefined) return {};
  return { traceId, spanId };
}
