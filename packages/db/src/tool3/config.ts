/**
 * Connection settings for the TOOL-3 harness. Two separate targets exist and never fall back to
 * each other:
 *  - `supabase`: TOOL-3 proper, local Supabase stack through its transaction-mode pooler
 *    (TOOL3_POOLER_URL, TOOL3_ADMIN_URL);
 *  - `supplemental`: sandbox-only evidence on plain PostgreSQL + PgBouncer
 *    (SUPPLEMENTAL_POOLER_URL, SUPPLEMENTAL_ADMIN_URL). NOT TOOL-3, NOT Supabase, NOT Supavisor.
 * URL values are never printed.
 */
export type Tool3Target = 'supabase' | 'supplemental';

export const FIXTURE_ROLE = 'tool3_app_api';

export interface Tool3Connections {
  readonly target: Tool3Target;
  readonly poolerUrl: URL;
  readonly adminUrl: URL;
}

export interface ExpectedPorts {
  readonly pooler: number;
  readonly admin: number;
}

export class Tool3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Tool3ConfigError';
  }
}

const VARIABLES: Record<Tool3Target, { pooler: string; admin: string }> = {
  supabase: { pooler: 'TOOL3_POOLER_URL', admin: 'TOOL3_ADMIN_URL' },
  supplemental: { pooler: 'SUPPLEMENTAL_POOLER_URL', admin: 'SUPPLEMENTAL_ADMIN_URL' },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parse(name: string, value: string | undefined): URL {
  if (value === undefined || value === '') throw new Tool3ConfigError(`${name} is required.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Tool3ConfigError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Tool3ConfigError(`${name} must be a postgres URL.`);
  if (!LOOPBACK.has(url.hostname)) throw new Tool3ConfigError(`${name} must point to a local (loopback) host.`);
  if (url.port === '') throw new Tool3ConfigError(`${name} must include a port.`);
  if (url.pathname.length <= 1) throw new Tool3ConfigError(`${name} must include a database name.`);
  return url;
}

export function readConnections(
  target: Tool3Target,
  source: Readonly<Record<string, string | undefined>>,
  expected?: ExpectedPorts,
): Tool3Connections {
  const names = VARIABLES[target];
  const poolerUrl = parse(names.pooler, source[names.pooler]);
  const adminUrl = parse(names.admin, source[names.admin]);
  const user = decodeURIComponent(poolerUrl.username);
  if (user !== FIXTURE_ROLE && !user.startsWith(`${FIXTURE_ROLE}.`)) {
    throw new Tool3ConfigError(`${names.pooler} must use the fixture role ${FIXTURE_ROLE} (optionally tenant-qualified).`);
  }
  if (poolerUrl.password !== '') {
    throw new Tool3ConfigError(`${names.pooler} must not contain a password; the fixture password is generated per run.`);
  }
  if (adminUrl.username === '' || adminUrl.password === '') {
    throw new Tool3ConfigError(`${names.admin} must include a user and password.`);
  }
  if (poolerUrl.port === adminUrl.port) {
    throw new Tool3ConfigError(`${names.pooler} and ${names.admin} must use different ports (pooler vs direct).`);
  }
  if (poolerUrl.pathname !== adminUrl.pathname) {
    throw new Tool3ConfigError(`${names.pooler} and ${names.admin} must use the same database.`);
  }
  if (expected !== undefined) {
    if (Number(poolerUrl.port) !== expected.pooler) throw new Tool3ConfigError(`${names.pooler} must use the configured pooler port ${expected.pooler}.`);
    if (Number(adminUrl.port) !== expected.admin) throw new Tool3ConfigError(`${names.admin} must use the configured database port ${expected.admin}.`);
  }
  return { target, poolerUrl, adminUrl };
}

/** The pooler URL with the per-run fixture password added. */
export function withPassword(url: URL, password: string): string {
  const copy = new URL(url.href);
  copy.password = encodeURIComponent(password);
  return copy.href;
}
