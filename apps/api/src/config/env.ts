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
  /** Server-only `app_system` connection string. Never logged; never sent to a browser. */
  readonly appSystemDatabaseUrl: string;
  readonly appSystemDatabaseMaxConnections: number;
  /** Server-only HMAC pepper for OTP digests (C-9). Never logged; never sent to a browser. */
  readonly otpPepper: string;
  readonly waabekBaseUrl: string;
  /** Server-only Waabek API key. Never logged; never sent to a browser. */
  readonly waabekApiKey: string;
  /**
   * Accepted internal BFF credentials, in order (CURRENT first, optional PREVIOUS second).
   * Server-only; never logged, never sent to a browser.
   */
  readonly internalBffCredentials: readonly string[];
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
  APP_SYSTEM_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
  APP_SYSTEM_DATABASE_MAX_CONNECTIONS: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(500)),
  // At least 32 bytes: the pepper is the only thing standing between a leaked digest and a six-digit
  // code that is trivially exhaustible.
  OTP_PEPPER: z.string().min(32),
  WAABEK_BASE_URL: z.string().regex(/^https?:\/\/\S+$/),
  WAABEK_API_KEY: z.string().min(1),
  // Owner decision C-2d: 32 random bytes as base64url (43 characters), one or two values separated by a
  // comma for overlap rotation — CURRENT first, then the PREVIOUS value still being retired.
  INTERNAL_BFF_CREDENTIAL: z.string().regex(/^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})?$/),
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
    appSystemDatabaseUrl: values.APP_SYSTEM_DATABASE_URL,
    appSystemDatabaseMaxConnections: values.APP_SYSTEM_DATABASE_MAX_CONNECTIONS,
    otpPepper: values.OTP_PEPPER,
    waabekBaseUrl: values.WAABEK_BASE_URL,
    waabekApiKey: values.WAABEK_API_KEY,
    internalBffCredentials: Object.freeze(values.INTERNAL_BFF_CREDENTIAL.split(',')),
  });
}

export const apiConfigLoadedEvent = () => configLoadedEvent('api', API_ENV_FIELDS);
