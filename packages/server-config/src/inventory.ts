/**
 * The single inventory of environment variables (owner decision R3, Phase 1 Step 7).
 * Every variable here is server-only: no variable may reach a browser bundle (R5).
 * Variables for features that are not built yet are deliberately absent (R1, R13).
 */
export type AppName = 'api' | 'worker' | 'web' | 'admin' | 'tooling';
export type RuntimeApp = Exclude<AppName, 'tooling'>;
export type EnvironmentName = 'local' | 'ci' | 'staging' | 'production';
export type VariableStatus = 'current' | 'tooling';

export interface InventoryEntry {
  readonly name: string;
  readonly apps: readonly AppName[];
  readonly required: boolean;
  /** Used when the variable is not set; null means no default. */
  readonly default: string | null;
  /** The value is a secret or may contain credentials. */
  readonly secret: boolean;
  readonly environments: readonly EnvironmentName[];
  /** current: read by an application's configuration module; tooling: read only by local/CI tooling. */
  readonly status: VariableStatus;
  readonly description: string;
  /**
   * Explicit, reviewed exception for the client-bundle leakage check (R5-a). Only NODE_ENV has one.
   */
  readonly clientBundleException?: string;
}

const RUNTIME_ENVIRONMENTS: readonly EnvironmentName[] = ['local', 'ci', 'staging', 'production'];
const TOOLING_ENVIRONMENTS: readonly EnvironmentName[] = ['local', 'ci'];

export const ENV_INVENTORY: readonly InventoryEntry[] = Object.freeze([
  {
    name: 'NODE_ENV',
    apps: ['api', 'worker'],
    required: true,
    default: null,
    secret: false,
    environments: RUNTIME_ENVIRONMENTS,
    status: 'current',
    description: 'development, test or production',
    clientBundleException:
      'Not a secret. Next.js and React reference the NODE_ENV name in their own client code (for example a framework warning message); the value is not configuration of ours.',
  },
  { name: 'LOG_LEVEL', apps: ['api', 'worker'], required: false, default: 'info', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'fatal, error, warn, info, debug or trace' },
  { name: 'API_HOST', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Address the API listens on' },
  { name: 'API_PORT', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Port the API listens on (1-65535)' },
  { name: 'REDIS_URL', apps: ['worker'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Redis connection URL; production requires rediss:// with a password' },
  { name: 'WORKER_CONCURRENCY', apps: ['worker'], required: false, default: '5', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Jobs processed in parallel per queue' },
  { name: 'WORKER_HEALTH_HOST', apps: ['worker'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Address of the internal health server' },
  { name: 'WORKER_HEALTH_PORT', apps: ['worker'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Port of the internal health server' },
  { name: 'WORKER_SHUTDOWN_TIMEOUT_MS', apps: ['worker'], required: false, default: '25000', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Graceful shutdown timeout in milliseconds' },
  { name: 'API_BASE_URL', apps: ['web', 'admin'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only API base URL for the BFF (http or https, no credentials); required at runtime, not at build' },
  { name: 'TOOL3_POOLER_URL', apps: ['tooling'], required: false, default: null, secret: false, environments: TOOLING_ENVIRONMENTS, status: 'tooling', description: 'TOOL-3: local Supabase pooler URL (fixture role, no password)' },
  { name: 'TOOL3_ADMIN_URL', apps: ['tooling'], required: false, default: null, secret: true, environments: TOOLING_ENVIRONMENTS, status: 'tooling', description: 'TOOL-3: direct local database URL with credentials' },
  { name: 'SUPPLEMENTAL_POOLER_URL', apps: ['tooling'], required: false, default: null, secret: false, environments: ['local'], status: 'tooling', description: 'Sandbox supplemental evidence (not TOOL-3): PgBouncer URL' },
  { name: 'SUPPLEMENTAL_ADMIN_URL', apps: ['tooling'], required: false, default: null, secret: true, environments: ['local'], status: 'tooling', description: 'Sandbox supplemental evidence (not TOOL-3): direct database URL with credentials' },
  { name: 'MARKETPLACE_TOOLCHAIN_DIR', apps: ['tooling'], required: false, default: null, secret: false, environments: TOOLING_ENVIRONMENTS, status: 'tooling', description: 'Where pinned external toolchains (Deno) are installed; must be outside the repository' },
  { name: 'ORVAL_OUTPUT', apps: ['tooling'], required: false, default: null, secret: false, environments: TOOLING_ENVIRONMENTS, status: 'tooling', description: 'Code generation (TOOL-2): temporary output path set by the contracts drift check' },
  { name: 'REDIS_SERVER_BIN', apps: ['tooling'], required: false, default: null, secret: false, environments: TOOLING_ENVIRONMENTS, status: 'tooling', description: 'redis-server binary used by the worker tests' },
]);

export function variablesFor(app: RuntimeApp): readonly InventoryEntry[] {
  return ENV_INVENTORY.filter((entry) => entry.status === 'current' && entry.apps.includes(app));
}
