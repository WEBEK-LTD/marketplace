import { activeTraceFields } from '@repo/telemetry';
import { destination as pinoDestination, pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from '../config/env.js';

/** Paths that are masked if they ever reach a log line. */
export const REDACTED_PATHS = ['redisUrl', 'url', 'password', '*.redisUrl', '*.url', '*.password'] as const;

export type WorkerLogger = Logger;

export function createLogger(level: LogLevel, destination?: DestinationStream): WorkerLogger {
  const options = {
    level,
    base: { service: 'worker' },
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    // Log correlation (O8-12): trace and span IDs of the active span, and a module name
    // ("runtime" unless the line or logger already names one).
    mixin(mergeObject: object, _level: number, logger: Logger) {
      const named = 'module' in mergeObject || 'module' in logger.bindings();
      return { ...(named ? {} : { module: 'runtime' }), ...activeTraceFields() };
    },
  };
  // Synchronous stdout so that no log line is lost or reordered when the process exits.
  return pino(options, destination ?? pinoDestination({ dest: 1, sync: true }));
}

/** Describes an error without its message or stack (they may contain internal details). */
export function errorSummary(error: unknown): { errorType: string; code?: string } {
  const type = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { errorType: type, code } : { errorType: type };
}
