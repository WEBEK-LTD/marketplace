import { SpanStatusCode, type Attributes, type AttributeValue, type Link, type SpanContext } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Strict allowlist (owner decision O8-13). Every other attribute is removed. Values that can carry a
 * URL are reduced to their path.
 */
export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  // HTTP servers (API hooks and Next.js built-in spans)
  'http.request.method',
  'http.method',
  'http.route',
  'http.response.status_code',
  'http.status_code',
  'http.url',
  'http.target',
  'next.span_type',
  'next.span_name',
  'next.route',
  'next.rsc',
  'next.segment',
  // Worker jobs (O8-8)
  'queue.name',
  'job.name',
  'job.attempt',
  // Database (O8-9)
  'db.system',
  // Errors: type only
  'error.type',
]);

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['http.url', 'http.target']);
const ALLOWED_EVENT_ATTRIBUTES: ReadonlySet<string> = new Set(['exception.type']);

/** Keeps only the path of a URL or request target: no scheme, host, credentials, query or fragment. */
export function pathOnly(value: string): string {
  const withoutFragment = value.split('#')[0] ?? '';
  const withoutQuery = withoutFragment.split('?')[0] ?? '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery)) {
    try {
      return new URL(withoutQuery).pathname;
    } catch {
      return '';
    }
  }
  return withoutQuery;
}

export function sanitizeSpanName(name: string): string {
  return name.split(/[?#]/)[0] ?? '';
}

function sanitizeValue(key: string, value: AttributeValue): AttributeValue | undefined {
  if (URL_ATTRIBUTES.has(key)) return typeof value === 'string' ? pathOnly(value) : undefined;
  return value;
}

export function sanitizeAttributes(attributes: Attributes, allowed: ReadonlySet<string> = ALLOWED_SPAN_ATTRIBUTES): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed.has(key) || value === undefined) continue;
    const clean = sanitizeValue(key, value);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function sanitizeEvent(event: TimedEvent): TimedEvent | undefined {
  // Only exception events survive, and only with their type (no message, no stack).
  if (event.name !== 'exception') return undefined;
  return { name: 'exception', time: event.time, attributes: sanitizeAttributes(event.attributes ?? {}, ALLOWED_EVENT_ATTRIBUTES) };
}

function sanitizeLink(link: Link): Link {
  return { context: link.context };
}

/** A sanitised copy of a finished span; the original span object is never passed on. */
export function sanitizeSpan(span: ReadableSpan, serviceName: string): ReadableSpan {
  const spanContext: SpanContext = span.spanContext();
  const events = span.events.map(sanitizeEvent).filter((event): event is TimedEvent => event !== undefined);
  return Object.freeze({
    name: sanitizeSpanName(span.name),
    kind: span.kind,
    spanContext: () => spanContext,
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status.code === SpanStatusCode.ERROR ? { code: SpanStatusCode.ERROR } : { code: span.status.code },
    attributes: sanitizeAttributes(span.attributes),
    links: span.links.map(sanitizeLink),
    events,
    duration: span.duration,
    ended: span.ended,
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    instrumentationScope: { name: span.instrumentationScope.name },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  });
}
