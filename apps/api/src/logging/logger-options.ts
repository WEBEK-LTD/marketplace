import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { activeTraceFields } from '@repo/telemetry';
import type { LogLevel } from '../config/env.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uses x-request-id only when it is a valid UUID; otherwise generates a new one. */
export function requestIdFor(request: IncomingMessage): string {
  const header = request.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && UUID_PATTERN.test(header) ? header.toLowerCase() : randomUUID();
}

/** Header paths that are always masked if they ever reach a log line. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["proxy-authorization"]',
  'headers["set-cookie"]',
] as const;

interface LogStream {
  write(line: string): void;
}

/** Structured JSON logging with Fastify's built-in logger. Request headers are never serialised. */
export function buildLoggerOptions(level: LogLevel, stream?: LogStream) {
  return {
    level,
    ...(stream === undefined ? {} : { stream }),
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    // Log correlation (O8-12): trace and span IDs of the active span, and a module name
    // ("http" unless the line or logger already names one).
    mixin(mergeObject: object, _level: number, logger: { bindings(): Record<string, unknown> }) {
      const named = 'module' in mergeObject || 'module' in logger.bindings();
      return { ...(named ? {} : { module: 'http' }), ...activeTraceFields() };
    },
    serializers: {
      req(request: { method: string; url: string }) {
        return { method: request.method, path: request.url.split('?')[0] ?? '' };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
