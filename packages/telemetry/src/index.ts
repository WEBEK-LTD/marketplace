export { ALLOWED_SPAN_ATTRIBUTES, pathOnly, sanitizeAttributes, sanitizeSpan, sanitizeSpanName } from './sanitize.js';
export {
  activeTraceFields,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  initTelemetry,
  SanitizingSpanProcessor,
  SPAN_LIMITS,
  type ServiceName,
  type Telemetry,
  type TelemetryOptions,
} from './telemetry.js';
export { context, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
