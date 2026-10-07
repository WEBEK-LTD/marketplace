/**
 * The single inventory of environment variables (owner decision R3, Phase 1 Step 7).
 * Every variable here is server-only: no variable may reach a browser bundle (R5).
 * Variables for features that are not built yet are deliberately absent (R1, R13).
 */
export type AppName = 'api' | 'worker' | 'web' | 'tooling';
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
  { name: 'PSEUDONYMOUS_USER_ID_KEY', apps: ['api', 'worker'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only HMAC-SHA-256 key for the pseudonymous user ID in logs (owner decision C-13, O8-12); at least 32 characters, cryptographically random. The API and the worker share one value per environment so a log correlates across both; different environments use different values. Never reaches a browser, a database, Redis, a response or telemetry' },
  { name: 'API_HOST', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Address the API listens on' },
  { name: 'API_PORT', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Port the API listens on (1-65535)' },
  { name: 'APP_SYSTEM_DATABASE_URL', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only PostgreSQL connection string for the app_system role, which reaches the database only through named SECURITY DEFINER functions' },
  { name: 'APP_SYSTEM_DATABASE_MAX_CONNECTIONS', apps: ['api'], required: false, default: '10', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Upper bound of pooled app_system connections (1-500)' },
  { name: 'DEVICE_IDENTITY_KEY', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only HMAC-SHA-256 key for the device identity digest stored in known_devices.device_hash (owner decision C-15); at least 32 characters, cryptographically random. Distinct from PSEUDONYMOUS_USER_ID_KEY and separately domain-separated; never reaches a browser, a database, Redis, a response or telemetry'},
  { name: 'ANALYTICS_SESSION_KEY', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only HMAC-SHA-256 key for the analytics session digest stored in listing_events.session_hash (0101 owner decision 4); at least 32 characters, cryptographically random. Distinct from PSEUDONYMOUS_USER_ID_KEY and DEVICE_IDENTITY_KEY and separately domain-separated, so an analytics digest can never be correlated with a device row or a log line; never reaches a browser, a database, Redis, a response or telemetry' },
  { name: 'OTP_PEPPER', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only HMAC-SHA-256 pepper for OTP code digests (owner decision C-9); at least 32 bytes' },
  { name: 'WAABEK_BASE_URL', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Base URL of the Waabek WhatsApp delivery API (http or https, no credentials); https://waabek.com in production' },
  { name: 'WAABEK_API_KEY', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only Waabek API key sent as the X-API-Key header; never reaches a browser' },
  { name: 'INTERNAL_BFF_CREDENTIAL', apps: ['api', 'web'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only internal BFF credential presented as the x-internal-credential header (owner decision C-2d); 32 random bytes as base64url. The API accepts CURRENT,PREVIOUS during rotation; the web deployment sends one value and accepts only a single credential. Since 0108 one Next.js deployment serves both the public marketplace and the staff console, so one value covers both surfaces' },
  { name: 'SUPABASE_URL', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Base URL of the Supabase project the API signs users in against (https, no credentials). Server-only: the browser never calls Supabase Auth (F2)' },
  { name: 'SUPABASE_SECRET_KEY', apps: ['api'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only Supabase secret key used for the password grant against Supabase Auth; never reaches a browser, a log or a response body (F2)' },
  { name: 'WEB_PUBLIC_ORIGIN', apps: ['api'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Origin of the public web app (https, no path), used server-side to build the password-reset recovery link (F3). Server-only: it is never returned by an API response and never reaches a client bundle' },
  { name: 'REDIS_URL', apps: ['api', 'worker'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Redis connection URL; production requires rediss:// with a password. The API uses it for the first login-throttle tier (owner decision C-1) and falls back to the durable PostgreSQL counter when it is unreachable' },
  { name: 'WORKER_CONCURRENCY', apps: ['worker'], required: false, default: '5', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Jobs processed in parallel per queue' },
  { name: 'WORKER_HEALTH_HOST', apps: ['worker'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Address of the internal health server' },
  { name: 'WORKER_HEALTH_PORT', apps: ['worker'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Port of the internal health server' },
  { name: 'WORKER_SHUTDOWN_TIMEOUT_MS', apps: ['worker'], required: false, default: '25000', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Graceful shutdown timeout in milliseconds' },
  { name: 'APP_WORKER_DATABASE_URL', apps: ['worker'], required: true, default: null, secret: true, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only PostgreSQL connection string for the app_worker role (Phase 7-D), which reaches the database only through the named SECURITY DEFINER outbox functions of migration 0008. Distinct from APP_SYSTEM_DATABASE_URL: the worker relays outboxes and holds no table privileges' },
  { name: 'APP_WORKER_DATABASE_MAX_CONNECTIONS', apps: ['worker'], required: false, default: '10', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Upper bound of pooled app_worker connections (1-500)' },
  { name: 'EMAIL_RELAY_INTERVAL_MS', apps: ['worker'], required: false, default: '15000', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'How often the email outbox relay claims a batch, in milliseconds (1000-3600000). Transport only: it sets the polling cadence and no delivery, retry or business rule' },
  { name: 'OUTBOX_RELAY_INTERVAL_MS', apps: ['worker'], required: false, default: '15000', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'How often the transactional outbox relay claims a batch, in milliseconds (1000-3600000). Transport only: it sets the polling cadence and no business, retry or completion rule' },
  { name: 'OUTBOX_SWEEPER_INTERVAL_MS', apps: ['worker'], required: false, default: '300000', secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'How often the outbox sweeper runs, in milliseconds (1000-3600000). The default matches the 5-minute staleness threshold that sweep_outbox_events itself defines; the threshold, not this cadence, decides what is stale' },
  { name: 'API_BASE_URL', apps: ['web'], required: true, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'Server-only API base URL for the BFF (http or https, no credentials); required at runtime, not at build' },
  { name: 'PUBLIC_WEB_ORIGIN', apps: ['web'], required: false, default: null, secret: false, environments: RUNTIME_ENVIRONMENTS, status: 'current', description: 'The public origin this site is served from — scheme and host only, no path, no trailing slash, no credentials (for example https://host.example). The sitemap protocol requires absolute URLs and the robots.txt Sitemap directive requires one, so they are built from this value and never from the request Host header, which a client controls. Deferred until the production domain is chosen: it is optional and has no default, and while it is unset the app runs normally, robots.txt is served without a Sitemap directive, and the sitemaps answer 404. Setting it is the only step needed to turn them on. When it IS set it is validated strictly, so a malformed value is a named start-up failure rather than a malformed document. Non-secret, but server-only all the same: it is read by the sitemap and robots routes, not shipped to a browser' },
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
