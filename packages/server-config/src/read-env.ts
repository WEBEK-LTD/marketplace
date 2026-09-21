import { variablesFor, type RuntimeApp } from './inventory.js';

/** Minimal validator contract (satisfied by Zod schemas and by the validators below). */
export interface FieldValidator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type FieldMap = Readonly<Record<string, FieldValidator<unknown>>>;
export type EnvValues<F extends FieldMap> = {
  readonly [K in keyof F]: F[K] extends FieldValidator<infer T> ? T : never;
};

/** Missing or invalid variables. Lists names only, never values. */
export class EnvValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/** An application's configuration module does not match the inventory (a programming error). */
export class InventoryDriftError extends Error {
  constructor(app: RuntimeApp, missing: readonly string[], extra: readonly string[]) {
    super(`Configuration for ${app} does not match the inventory (missing: ${missing.join(', ') || 'none'}; not in inventory: ${extra.join(', ') || 'none'})`);
    this.name = 'InventoryDriftError';
  }
}

export function assertFieldsMatchInventory(app: RuntimeApp, fields: FieldMap): void {
  const expected = variablesFor(app).map((entry) => entry.name);
  const actual = Object.keys(fields);
  const missing = expected.filter((name) => !actual.includes(name)).sort();
  const extra = actual.filter((name) => !expected.includes(name)).sort();
  if (missing.length > 0 || extra.length > 0) throw new InventoryDriftError(app, missing, extra);
}

/**
 * Reads an application's variables once. Required-ness and defaults come from the inventory;
 * only an unset variable (undefined) is "missing" and gets the default. The result is frozen:
 * configuration never changes at runtime; rotation means a restart (R12).
 */
export function readEnv<F extends FieldMap>(
  app: RuntimeApp,
  fields: F,
  source: Readonly<Record<string, string | undefined>>,
): EnvValues<F> {
  assertFieldsMatchInventory(app, fields);
  const invalid = new Set<string>();
  const values: Record<string, unknown> = {};
  for (const entry of variablesFor(app)) {
    const raw = source[entry.name] ?? entry.default ?? undefined;
    if (raw === undefined) {
      if (entry.required) invalid.add(entry.name);
      continue;
    }
    const parsed = (fields[entry.name] as FieldValidator<unknown>).safeParse(raw);
    if (parsed.success) values[entry.name] = parsed.data;
    else invalid.add(entry.name);
  }
  if (invalid.size > 0) throw new EnvValidationError([...invalid].sort());
  return Object.freeze(values) as EnvValues<F>;
}

/** http(s) URL with a host and without embedded credentials. */
export const httpUrlWithoutCredentials: FieldValidator<string> = {
  safeParse(value: unknown) {
    if (typeof value !== 'string') return { success: false };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { success: false };
    }
    const ok = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
    return ok ? { success: true, data: value } : { success: false };
  },
};

/**
 * Exactly one internal BFF credential: 32 random bytes as base64url, which is 43 unpadded characters
 * (owner decision C-2d).
 *
 * The API deliberately accepts `CURRENT,PREVIOUS` so that a credential can be replaced without
 * downtime. A BFF is the other side of that rotation and sends only `CURRENT`, so a pair here is a
 * configuration mistake rather than a rotation: sending `"CURRENT,PREVIOUS"` as one header value would
 * match nothing and every call would be refused. Rejecting it at start-up turns that into an immediate,
 * named failure instead of a site that builds and then 403s on every request.
 */
export const internalBffCredential: FieldValidator<string> = {
  safeParse(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
      ? { success: true, data: value }
      : { success: false };
  },
};

/** Fields of the Next.js server runtime (web and admin). */
export const NEXT_SERVER_FIELDS = Object.freeze({
  API_BASE_URL: httpUrlWithoutCredentials,
  INTERNAL_BFF_CREDENTIAL: internalBffCredential,
});

export interface NextServerConfig {
  readonly apiBaseUrl: string;
  /** Server runtime only. Never returned to a browser, never logged, never in a client bundle. */
  readonly internalBffCredential: string;
}

export function readNextServerConfig(app: 'web' | 'admin', source: Readonly<Record<string, string | undefined>>): NextServerConfig {
  const values = readEnv(app, NEXT_SERVER_FIELDS, source);
  return Object.freeze({ apiBaseUrl: values.API_BASE_URL, internalBffCredential: values.INTERNAL_BFF_CREDENTIAL });
}

/**
 * The only configuration log event (R11): no values, no variable names, only safe metadata.
 */
export function configLoadedEvent(component: RuntimeApp, fields: FieldMap) {
  return Object.freeze({ event: 'config_loaded' as const, component, variablesValidated: Object.keys(fields).length });
}
