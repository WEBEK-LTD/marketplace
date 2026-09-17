import { configLoadedEvent, readEnv } from '@repo/server-config';
import { z } from 'zod';

export { EnvValidationError } from '@repo/server-config';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiEnv {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

/** Validators for the API's inventory entries (required-ness and defaults come from the inventory). */
export const API_ENV_FIELDS = Object.freeze({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(LOG_LEVELS),
  API_HOST: z.string().regex(/^\S+$/),
  API_PORT: z
    .string()
    .regex(/^[1-9]\d{0,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
});

/**
 * The API's only reader of the process environment. Values are read once at start-up and frozen.
 * Errors list variable names only, never values.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): ApiEnv {
  const values = readEnv('api', API_ENV_FIELDS, source);
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    host: values.API_HOST,
    port: values.API_PORT,
    logLevel: values.LOG_LEVEL,
  });
}

export const apiConfigLoadedEvent = () => configLoadedEvent('api', API_ENV_FIELDS);
