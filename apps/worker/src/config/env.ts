import { configLoadedEvent, EnvValidationError, readEnv, variablesFor } from '@repo/server-config';
import { z } from 'zod';

export { EnvValidationError } from '@repo/server-config';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = 'development' | 'test' | 'production';

function inventoryDefault(name: string): number {
  return Number(variablesFor('worker').find((entry) => entry.name === name)?.default);
}

/** Defaults are defined in the inventory; these constants mirror them. */
export const DEFAULT_CONCURRENCY = inventoryDefault('WORKER_CONCURRENCY');
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = inventoryDefault('WORKER_SHUTDOWN_TIMEOUT_MS');

export interface WorkerEnv {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  /** Never log this value; it may contain a password. */
  readonly redisUrl: string;
  readonly concurrency: number;
  readonly health: { readonly host: string; readonly port: number };
  readonly shutdownTimeoutMs: number;
}

const positiveInt = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/** Validators for the worker's inventory entries (required-ness and defaults come from the inventory). */
export const WORKER_ENV_FIELDS = Object.freeze({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(LOG_LEVELS),
  REDIS_URL: z.string().min(1),
  WORKER_CONCURRENCY: positiveInt(Number.MAX_SAFE_INTEGER),
  WORKER_HEALTH_HOST: z.string().regex(/^\S+$/),
  WORKER_HEALTH_PORT: positiveInt(65535),
  WORKER_SHUTDOWN_TIMEOUT_MS: positiveInt(Number.MAX_SAFE_INTEGER),
});

/** redis:// only in development/test; production requires rediss:// with a password. */
function isAllowedRedisUrl(value: string, nodeEnv: NodeEnv): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hostname.length === 0) return false;
  if (nodeEnv === 'production') {
    return url.protocol === 'rediss:' && url.password.length > 0;
  }
  return url.protocol === 'redis:' || url.protocol === 'rediss:';
}

/**
 * The worker's only reader of the process environment. Values are read once at start-up and frozen.
 * Errors list variable names only, never values.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): WorkerEnv {
  const data = readEnv('worker', WORKER_ENV_FIELDS, source);
  if (!isAllowedRedisUrl(data.REDIS_URL, data.NODE_ENV)) {
    throw new EnvValidationError(['REDIS_URL']);
  }
  return Object.freeze({
    nodeEnv: data.NODE_ENV,
    logLevel: data.LOG_LEVEL,
    redisUrl: data.REDIS_URL,
    concurrency: data.WORKER_CONCURRENCY,
    health: Object.freeze({ host: data.WORKER_HEALTH_HOST, port: data.WORKER_HEALTH_PORT }),
    shutdownTimeoutMs: data.WORKER_SHUTDOWN_TIMEOUT_MS,
  });
}

export const workerConfigLoadedEvent = () => configLoadedEvent('worker', WORKER_ENV_FIELDS);
