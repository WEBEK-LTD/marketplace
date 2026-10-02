import {
  configLoadedEvent,
  EnvValidationError,
  MIN_PSEUDONYMOUS_KEY_LENGTH,
  readEnv,
  variablesFor,
} from '@repo/server-config';
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
export const DEFAULT_DATABASE_MAX_CONNECTIONS = inventoryDefault('APP_WORKER_DATABASE_MAX_CONNECTIONS');
export const DEFAULT_EMAIL_RELAY_INTERVAL_MS = inventoryDefault('EMAIL_RELAY_INTERVAL_MS');
export const DEFAULT_OUTBOX_RELAY_INTERVAL_MS = inventoryDefault('OUTBOX_RELAY_INTERVAL_MS');
export const DEFAULT_OUTBOX_SWEEPER_INTERVAL_MS = inventoryDefault('OUTBOX_SWEEPER_INTERVAL_MS');

export interface WorkerEnv {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  /** Never log this value; it may contain a password. */
  readonly redisUrl: string;
  /**
   * Server-only HMAC key for the pseudonymous user ID in job logs (C-13, O8-12).
   *
   * The same value the API uses within one environment, so a job and the request that queued it name
   * the same person identically. Never logged; never stored; never sent anywhere.
   */
  readonly pseudonymousUserIdKey: string;
  readonly concurrency: number;
  readonly health: { readonly host: string; readonly port: number };
  readonly shutdownTimeoutMs: number;
  /**
   * Server-only connection string for the `app_worker` role (Phase 7-D). Never log this value.
   *
   * `app_worker` holds no table privileges anywhere (migration 0003, contract 0031), so this pool can
   * only reach the database through the named SECURITY DEFINER functions of migration 0008.
   */
  readonly appWorkerDatabaseUrl: string;
  readonly appWorkerDatabaseMaxConnections: number;
  /** Polling cadence of the email outbox relay. Transport only; it decides no delivery outcome. */
  readonly emailRelayIntervalMs: number;
  /**
   * Polling cadence of the transactional outbox relay (Phase 8-A). Transport only: what the relay may
   * claim is decided by the handler registry, and what it does with a claim by the handler.
   */
  readonly outboxRelayIntervalMs: number;
  /**
   * How often the sweeper runs. The staleness threshold is `sweep_outbox_events`' own five minutes and
   * is not configurable here; this only says how often that question is asked.
   */
  readonly outboxSweeperIntervalMs: number;
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
  // C-13. Length only: the value is opaque, and the floor catches a misconfigured deployment.
  PSEUDONYMOUS_USER_ID_KEY: z.string().min(MIN_PSEUDONYMOUS_KEY_LENGTH),
  WORKER_CONCURRENCY: positiveInt(Number.MAX_SAFE_INTEGER),
  WORKER_HEALTH_HOST: z.string().regex(/^\S+$/),
  WORKER_HEALTH_PORT: positiveInt(65535),
  WORKER_SHUTDOWN_TIMEOUT_MS: positiveInt(Number.MAX_SAFE_INTEGER),
  // Shape only: the same rule the API applies to APP_SYSTEM_DATABASE_URL. The value is never logged.
  APP_WORKER_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
  // 0008's own bound on claim batches is 1-500; the pool may not promise more than the database allows.
  APP_WORKER_DATABASE_MAX_CONNECTIONS: positiveInt(500),
  // A floor of one second: a relay that polls faster than that is a misconfiguration, not a tuning.
  EMAIL_RELAY_INTERVAL_MS: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(3_600_000)),
  // Phase 8-A: the same floor and ceiling the email relay uses, for the same reason.
  OUTBOX_RELAY_INTERVAL_MS: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(3_600_000)),
  OUTBOX_SWEEPER_INTERVAL_MS: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(3_600_000)),
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
    pseudonymousUserIdKey: data.PSEUDONYMOUS_USER_ID_KEY,
    concurrency: data.WORKER_CONCURRENCY,
    health: Object.freeze({ host: data.WORKER_HEALTH_HOST, port: data.WORKER_HEALTH_PORT }),
    shutdownTimeoutMs: data.WORKER_SHUTDOWN_TIMEOUT_MS,
    appWorkerDatabaseUrl: data.APP_WORKER_DATABASE_URL,
    appWorkerDatabaseMaxConnections: data.APP_WORKER_DATABASE_MAX_CONNECTIONS,
    emailRelayIntervalMs: data.EMAIL_RELAY_INTERVAL_MS,
    outboxRelayIntervalMs: data.OUTBOX_RELAY_INTERVAL_MS,
    outboxSweeperIntervalMs: data.OUTBOX_SWEEPER_INTERVAL_MS,
  });
}

export const workerConfigLoadedEvent = () => configLoadedEvent('worker', WORKER_ENV_FIELDS);
