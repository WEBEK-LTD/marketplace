import {
  configLoadedEvent,
  MIN_DEVICE_KEY_LENGTH,
  MIN_PSEUDONYMOUS_KEY_LENGTH,
  readEnv,
} from '@repo/server-config';
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
  /**
   * Server-only HMAC key for the device identity digest (C-15).
   *
   * Distinct from the pseudonymous-ID key and separately domain-separated, so the two schemes can
   * never produce the same value for the same input. Never logged; never sent to a browser.
   */
  readonly deviceIdentityKey: string;
  /** Server-only HMAC pepper for OTP digests (C-9). Never logged; never sent to a browser. */
  readonly otpPepper: string;
  /**
   * Server-only HMAC key for the pseudonymous user ID in logs (C-13, O8-12).
   *
   * Shared with the worker within one environment so that a log line from either service names the
   * same person the same way. Never logged; never sent to a browser; never stored.
   */
  readonly pseudonymousUserIdKey: string;
  readonly waabekBaseUrl: string;
  /** Server-only Waabek API key. Never logged; never sent to a browser. */
  readonly waabekApiKey: string;
  /**
   * Accepted internal BFF credentials, in order (CURRENT first, optional PREVIOUS second).
   * Server-only; never logged, never sent to a browser.
   */
  readonly internalBffCredentials: readonly string[];
  /** Supabase project base URL. The browser never calls it: sign-in happens here (F2). */
  readonly supabaseUrl: string;
  /** Server-only Supabase secret key for the password grant. Never logged; never sent to a browser. */
  readonly supabaseSecretKey: string;
  /** Redis URL for the first login-throttle tier (C-1). Server-only. */
  readonly redisUrl: string;
  /**
   * Origin of the public web app, used to build the password-reset recovery link (F3).
   *
   * Server-only. The link is composed here and handed to the BFF across one internal hop; the origin
   * itself is never returned by a response and never reaches a client bundle.
   */
  readonly webPublicOrigin: string;
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
  // C-15. Length only, like the other opaque keys: the floor catches a misconfigured deployment.
  DEVICE_IDENTITY_KEY: z.string().min(MIN_DEVICE_KEY_LENGTH),
  OTP_PEPPER: z.string().min(32),
  // C-13. Only length is checked: the value is opaque, and its job is to be unguessable. The floor
  // exists to catch a misconfigured deployment, not to certify entropy.
  PSEUDONYMOUS_USER_ID_KEY: z.string().min(MIN_PSEUDONYMOUS_KEY_LENGTH),
  WAABEK_BASE_URL: z.string().regex(/^https?:\/\/\S+$/),
  WAABEK_API_KEY: z.string().min(1),
  // Owner decision C-2d: 32 random bytes as base64url (43 characters), one or two values separated by a
  // comma for overlap rotation — CURRENT first, then the PREVIOUS value still being retired.
  INTERNAL_BFF_CREDENTIAL: z.string().regex(/^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})?$/),
  // https only, no embedded credentials, no path: the API appends `/auth/v1/...` itself.
  SUPABASE_URL: z.string().regex(/^https:\/\/[^\s/@]+\/?$/),
  // Shape is the provider's, so only "present and not trivially empty" is checked here. It is never
  // logged and never leaves the server.
  SUPABASE_SECRET_KEY: z.string().min(20),
  REDIS_URL: z.string().min(1),
  // An origin: scheme and host only, no path, no credentials, no trailing slash of significance. The
  // recovery link is built by appending a path, so a value carrying one would produce a broken link.
  WEB_PUBLIC_ORIGIN: z.string().regex(/^https?:\/\/[^\s/@]+\/?$/),
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
    deviceIdentityKey: values.DEVICE_IDENTITY_KEY,
    otpPepper: values.OTP_PEPPER,
    pseudonymousUserIdKey: values.PSEUDONYMOUS_USER_ID_KEY,
    waabekBaseUrl: values.WAABEK_BASE_URL,
    waabekApiKey: values.WAABEK_API_KEY,
    internalBffCredentials: Object.freeze(values.INTERNAL_BFF_CREDENTIAL.split(',')),
    supabaseUrl: values.SUPABASE_URL.replace(/\/$/, ''),
    supabaseSecretKey: values.SUPABASE_SECRET_KEY,
    redisUrl: values.REDIS_URL,
    webPublicOrigin: values.WEB_PUBLIC_ORIGIN.replace(/\/$/, ''),
  });
}

export const apiConfigLoadedEvent = () => configLoadedEvent('api', API_ENV_FIELDS);
