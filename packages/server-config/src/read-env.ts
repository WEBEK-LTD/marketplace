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
 * An http(s) **origin**: scheme and host only.
 *
 * Stricter than {@link httpUrlWithoutCredentials}, and deliberately so. This value is concatenated with
 * site-relative paths to build the absolute URLs the sitemap protocol requires, so a trailing slash, a path,
 * a query or a fragment would each produce malformed URLs in a document crawlers read. Rather than trimming
 * the value and guessing what was meant, the comparison against `URL.origin` refuses anything that is not
 * already exactly an origin, and says so by name at start-up.
 *
 * A default port is normalised away by `URL.origin` (`https://host.example:443` becomes
 * `https://host.example`), which would make the check fail on a value that is arguably correct. Both forms
 * name the same origin, so the normalised form is the one to configure, and the error names the variable.
 */
export const httpOrigin: FieldValidator<string> = {
  safeParse(value: unknown) {
    if (typeof value !== 'string') return { success: false };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { success: false };
    }
    const ok =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      // No path, query or fragment, and no trailing slash: the value must already be an origin.
      value === url.origin;
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

/** Fields the two Next.js server runtimes share. */
export const NEXT_SERVER_FIELDS = Object.freeze({
  API_BASE_URL: httpUrlWithoutCredentials,
  INTERNAL_BFF_CREDENTIAL: internalBffCredential,
});

/**
 * Fields of the public web server runtime.
 *
 * The admin console has no public origin and no sitemap — it is never indexed — so `PUBLIC_WEB_ORIGIN`
 * belongs to one app rather than both. `readEnv` checks the field map against the inventory for the app it
 * is given, so this split is what keeps the admin console from being asked for a variable it has no use for.
 *
 * `PUBLIC_WEB_ORIGIN` is **optional** while the production domain is undecided, and the validator is the strict
 * one all the same. The two are separate questions: whether a value must be present, which the inventory
 * answers, and whether a present value is acceptable, which the validator answers. So an unset variable is
 * simply absent, and a set-but-malformed one is still a named start-up failure.
 */
export const WEB_SERVER_FIELDS = Object.freeze({
  ...NEXT_SERVER_FIELDS,
  PUBLIC_WEB_ORIGIN: httpOrigin,
});

export interface NextServerConfig {
  readonly apiBaseUrl: string;
  /** Server runtime only. Never returned to a browser, never logged, never in a client bundle. */
  readonly internalBffCredential: string;
}

export interface WebServerConfig extends NextServerConfig {
  /**
   * Scheme and host only, with no trailing slash — the one authorized source of absolute public URLs — or
   * `null` while no production domain is configured.
   *
   * `null` means deferred, never "work it out from somewhere else". Nothing derives an origin from the request
   * `Host` header, `X-Forwarded-Host`, or a guess at localhost: a client controls those, so a poisoned one
   * would publish a sitemap advertising somebody else's origin. The documents that cannot be built without an
   * absolute URL stay unavailable instead.
   */
  readonly publicWebOrigin: string | null;
}

export function readNextServerConfig(app: 'admin', source: Readonly<Record<string, string | undefined>>): NextServerConfig {
  const values = readEnv(app, NEXT_SERVER_FIELDS, source);
  return Object.freeze({ apiBaseUrl: values.API_BASE_URL, internalBffCredential: values.INTERNAL_BFF_CREDENTIAL });
}

export function readWebServerConfig(source: Readonly<Record<string, string | undefined>>): WebServerConfig {
  const values = readEnv('web', WEB_SERVER_FIELDS, source);
  // `readEnv` leaves out an optional variable that is unset and has no default, so the value map's type is
  // optimistic for that one entry. Widened here deliberately rather than asserted away, because the whole point
  // of this field is that its absence is an ordinary state the app has to carry.
  const origin: string | undefined = values.PUBLIC_WEB_ORIGIN;
  return Object.freeze({
    apiBaseUrl: values.API_BASE_URL,
    internalBffCredential: values.INTERNAL_BFF_CREDENTIAL,
    publicWebOrigin: origin ?? null,
  });
}

/**
 * The only configuration log event (R11): no values, no variable names, only safe metadata.
 */
export function configLoadedEvent(component: RuntimeApp, fields: FieldMap) {
  return Object.freeze({ event: 'config_loaded' as const, component, variablesValidated: Object.keys(fields).length });
}
