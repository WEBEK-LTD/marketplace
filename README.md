# Marketplace monorepo (Phase 1 complete, Phase 2 in progress)

Workspace scope `@repo/*` is a neutral technical placeholder and must be replaced before production branding.

## Layout

| Path | Workspace | Status |
| --- | --- | --- |
| `apps/web` | `@repo/web` | Placeholder; public Next.js app added in a later Phase 1 step |
| `apps/admin` | `@repo/admin` | Placeholder; separate Next.js admin app added later |
| `apps/api` | `@repo/api` | Implemented (Step 3): NestJS 12 + Fastify baseline |
| `apps/worker` | `@repo/worker` | Implemented (Step 4): BullMQ worker skeleton on Redis |
| `packages/contracts` | `@repo/contracts` | Implemented (Step 3): Zod contracts, OpenAPI, generated client |
| `packages/money` | `@repo/money` | Implemented (Step 2) |
| `packages/shared-types` | `@repo/shared-types` | Implemented (Step 2) |
| `packages/config` | `@repo/config` | Implemented (Step 2): neutral design tokens |
| `packages/ui` | `@repo/ui` | Implemented (Step 5): shared React primitives |
| `packages/db` | `@repo/db` | Implemented (Step 6): server-only Kysely factory and RLS transaction helper |
| `packages/server-config` | `@repo/server-config` | Implemented (Step 7): environment variable inventory and server-only configuration reader |
| `packages/telemetry` | `@repo/telemetry` | Implemented (Step 8): vendor-neutral tracing and log correlation (server-only) |
| `packages/e2e` | `@repo/e2e` | Implemented (Step 9): Playwright smoke tests (TOOL-7), test tooling only |

## `@repo/api`

- NestJS 12 on Fastify (no Express), ESM, strict TypeScript with decorator metadata.
- Routes: `GET /health` (liveness) and `GET /ready` (readiness; empty dependency-check list until Redis and the database are added). Both are internal and outside `/v1`. There are no `/v1` routes yet, so the internal BFF credential is not implemented yet.
- Environment (validated at start-up; errors list variable names only): `NODE_ENV` (`development` | `test` | `production`, required), `API_HOST` (required), `API_PORT` (required), `LOG_LEVEL` (default `info`).
- Security baseline: helmet headers; no CORS headers at all (no cross-origin access); request bodies accepted only as `application/json` (every other media type, including form-urlencoded and text/plain, gets 415; the server refuses to start if another body parser is registered); 1 MiB JSON body limit (413); Zod validation pipe for inputs.
- Errors: RFC 9457 `application/problem+json` with `type: "about:blank"`, `title`, `status`, `detail`, `instance` (request path), a stable `code` and, for validation failures, `errors` (field path + message). No stack traces or internal messages.
- Logging: structured JSON through Fastify's logger; request lines contain method and path only; authorization, cookie and proxy credentials are redacted. Every response carries `x-request-id`; a supplied `x-request-id` is used only if it is a valid UUID.
- Graceful shutdown on SIGTERM/SIGINT: in-flight requests finish, their connections close, and the process exits with code 0.
- The OpenAPI document is not served by the API.

## `@repo/web` and `@repo/admin`

- Next.js 16 (App Router, Turbopack), React 19, next-intl 4, Tailwind CSS 4. Local ports: web 3000, admin 3001. Built for Netlify with `@netlify/plugin-nextjs`; each app has a `netlify.toml` (configuration only, no Netlify site exists).
- Every HTML response is rendered per request and carries a nonce-based CSP (`default-src 'self'`; scripts and styles only from this origin with the request's nonce and `'strict-dynamic'`; `object-src 'none'`; `frame-ancestors 'none'`; no `unsafe-inline`/`unsafe-eval`). Static headers on every response: HSTS, `nosniff`, `Referrer-Policy` (`strict-origin-when-cross-origin` on web, `no-referrer` on admin), a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` and `X-Robots-Tag: noindex` (Step 5 pages are not indexable; admin stays noindex). No sitemap, robots file, canonical or hreflang yet.
- `src/proxy.ts` only handles locale routing and the CSP nonce; it never authorizes.
- Public web: English at `/`, Arabic at `/ar` (right-to-left). The URL alone decides the language: no Accept-Language redirect and no locale cookie; `/en` redirects to `/`. The header links to the other language.
- Admin: no `/ar` prefix; the language will come from the user profile. Until profiles exist the resolver returns English; Arabic messages and the right-to-left frame are tested with an explicit locale.
- Unknown URLs return a server-rendered, localized 404. There is deliberately no catch-all route: Next.js 16 does not server-render not-found pages reached through `notFound()` (vercel/next.js#98295).
- Placeholder content only (site name "Marketplace" / "السوق", neutral home pages); no production branding.
- BFF skeleton (`src/server/bff`, server-only): validated `API_BASE_URL` (required at runtime, `http`/`https`, no credentials), the generated API client, and an Origin/CSRF check (state-changing requests need an `Origin` equal to the request origin, or `Sec-Fetch-Site: same-origin`). No route handlers, no API forwarding, no authentication. No `NEXT_PUBLIC_*` variables.
- Tests start the built app with `next start` and check it over HTTP (headers, per-request nonces on every script, locale and direction, 404s, noindex, client bundles free of server-only code, token-only CSS).

## `@repo/ui`

Shared primitives used by both apps: `PageContainer`, `SkipLink`, `Heading`. App headers and footers stay in each app.

## Server-only environment configuration

- `@repo/server-config` holds the single inventory of environment variables and the shared reader. Each application declares validators for exactly its inventory entries; required-ness and defaults come from the inventory, and a mismatch stops the application (and fails the tests). Only an unset variable counts as missing; an empty value is invalid. Configuration is read once at start-up and frozen; changing a value means a restart or redeploy. There is no hot reload, runtime mutation or secrets manager. Where production secrets come from is decided with the hosting decisions (Gate C).
- Only the configuration modules read `process.env`: `apps/api/src/config/env.ts`, `apps/worker/src/config/env.ts` and `apps/{web,admin}/src/server/config.ts`. Documented exceptions: `apps/{web,admin}/src/instrumentation.ts` reads `NEXT_RUNTIME` (set by Next.js); `apps/worker/src/runtime/pure-js-msgpack.ts` sets `MSGPACKR_NATIVE_ACCELERATION_DISABLED`; `packages/contracts/orval.config.mjs` reads `ORVAL_OUTPUT` (code generation); tooling scripts (`scripts/`, `apps/*/scripts/`, `packages/*/scripts/`), tests and the TOOL-3 harness. `pnpm run check:env` enforces this with a TypeScript syntax-tree check, which also catches aliased, destructured, dynamic and `node:process` access.
- Web and admin: `src/server/config.ts` and the BFF modules import `server-only`. `src/instrumentation.ts` validates `API_BASE_URL` when the Node.js server starts; if it is missing or invalid, Next.js 16 logs the error (names only) and answers every request with HTTP 500. The local `start` script first runs `scripts/preflight-next-env.mjs`, which exits with code 1 before `next start` if the configuration is invalid. How the Netlify runtime handles a failing instrumentation hook has not been verified. In tests, Vitest aliases `server-only` to an empty shim; React resolves normally.
- Every application logs one `config_loaded` event at start-up with the component name and the number of validated variables only: no values and no variable names.
- `pnpm run check:client-env` (after building web and admin) fails if any inventory variable name or any `NEXT_PUBLIC_` name appears in the web or admin client bundles. The only exception, recorded in the inventory, is `NODE_ENV`: it is not a secret, and Next.js and React mention the name in their own client code.
- Local development: each application has a `.env.example` with names only. Copy it to `.env` in the application folder and set values locally. The API and worker load it only through `pnpm run dev` (`node --env-file-if-exists=.env`); Next.js loads `.env` files itself. `.env` files are ignored by git, and `pnpm run check:env` fails if one is in the repository or if an example contains a value. CI and deployed environments supply variables through the platform only.
- `APP_ENV` is not used in Phase 1; it is reconsidered at the start of Phase 2 with staging. Variables for features that are not built yet are not in the inventory.

### Environment variable inventory

<!-- env-inventory:start (generated by `pnpm run check:env -- --write-docs`; do not edit) -->
| Variable | Used by | Required | Default | Secret | Environments | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | api, worker | yes | — | no | local, ci, staging, production | current | development, test or production (client-bundle exception: Not a secret. Next.js and React reference the NODE_ENV name in their own client code (for example a framework warning message); the value is not configuration of ours.) |
| `LOG_LEVEL` | api, worker | no | `info` | no | local, ci, staging, production | current | fatal, error, warn, info, debug or trace |
| `API_HOST` | api | yes | — | no | local, ci, staging, production | current | Address the API listens on |
| `API_PORT` | api | yes | — | no | local, ci, staging, production | current | Port the API listens on (1-65535) |
| `REDIS_URL` | worker | yes | — | yes | local, ci, staging, production | current | Redis connection URL; production requires rediss:// with a password |
| `WORKER_CONCURRENCY` | worker | no | `5` | no | local, ci, staging, production | current | Jobs processed in parallel per queue |
| `WORKER_HEALTH_HOST` | worker | yes | — | no | local, ci, staging, production | current | Address of the internal health server |
| `WORKER_HEALTH_PORT` | worker | yes | — | no | local, ci, staging, production | current | Port of the internal health server |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | worker | no | `25000` | no | local, ci, staging, production | current | Graceful shutdown timeout in milliseconds |
| `API_BASE_URL` | web, admin | yes | — | no | local, ci, staging, production | current | Server-only API base URL for the BFF (http or https, no credentials); required at runtime, not at build |
| `TOOL3_POOLER_URL` | tooling | no | — | no | local, ci | tooling | TOOL-3: local Supabase pooler URL (fixture role, no password) |
| `TOOL3_ADMIN_URL` | tooling | no | — | yes | local, ci | tooling | TOOL-3: direct local database URL with credentials |
| `SUPPLEMENTAL_POOLER_URL` | tooling | no | — | no | local | tooling | Sandbox supplemental evidence (not TOOL-3): PgBouncer URL |
| `SUPPLEMENTAL_ADMIN_URL` | tooling | no | — | yes | local | tooling | Sandbox supplemental evidence (not TOOL-3): direct database URL with credentials |
| `MARKETPLACE_TOOLCHAIN_DIR` | tooling | no | — | no | local, ci | tooling | Where pinned external toolchains (Deno) are installed; must be outside the repository |
| `ORVAL_OUTPUT` | tooling | no | — | no | local, ci | tooling | Code generation (TOOL-2): temporary output path set by the contracts drift check |
| `REDIS_SERVER_BIN` | tooling | no | — | no | local, ci | tooling | redis-server binary used by the worker tests |
<!-- env-inventory:end -->

## Telemetry: tracing and log correlation

- Vendor-neutral OpenTelemetry tracing with explicit instrumentation only (no automatic instrumentation, module hooking, loader hooks or SDK bundle), through `@repo/telemetry`. Nothing is exported: there is no exporter, collector, backend or vendor in Phase 1, and finished spans are dropped (tests record them in memory). Metrics, browser telemetry, error tracking, uptime, alerting and dashboards are not part of Phase 1.
- `initTelemetry({ serviceName })` registers the process-wide tracer provider once: AlwaysOn sampling, explicit span limits, resource `service.name` only (`api`, `worker`, `web` or `admin`; no resource detectors, host names, command lines or `deployment.environment`), and no propagator, so incoming `traceparent` headers are ignored and every request starts a new trace. Configuration is programmatic; `OTEL_*` and `NEXT_OTEL_*` variables are not configuration and are not in the inventory (tests set hostile `OTEL_*` values and check that nothing changes).
- Every finished span passes through a strict attribute allowlist before anything could receive it: only HTTP method, route template, status code, `http.url`/`http.target` reduced to their path, Next.js span metadata, `queue.name`, `job.name`, `job.attempt`, `db.system` and `error.type`. Span names lose query strings; exception events keep only the type; status messages and link attributes are dropped. Headers, cookies, bodies, query strings, SQL text and parameters, Redis commands, job payloads, claims, error messages, stacks and credentials never survive (tested with canary values).
- API: Fastify hooks start one root span per request (`<METHOD> <route template>`, or `unmatched route`) and keep it active for the rest of the request; server errors add the error type. Telemetry starts in `main.ts` before the application and shuts down (at most 2 s) when the server closes.
- Worker: one root span per job attempt (`process <queue>`) with queue, job name and attempt; failures add the error type. No telemetry metadata is added to jobs. Telemetry starts in `main.ts` and shuts down (at most 2 s) after the job drain.
- `@repo/db`: `withRlsContext` runs inside a `db.transaction` span with `db.system=postgresql` only.
- Web and admin: `instrumentation.ts` registers the provider in the Node.js runtime after validating the configuration, so Next.js creates its built-in spans (subject to the same allowlist). OpenTelemetry code stays out of the client bundles (tested). How the Netlify runtime, which uses the OpenTelemetry API itself, interacts with this provider has not been verified.
- Logs: API and worker log lines include `traceId` and `spanId` when a span is active, and a `module` (`http`, `nest` or `config` in the API; `runtime`, `redis`, `queue` or `config` in the worker). Existing redaction is unchanged. A pseudonymous user ID follows with authentication (Phase 3); web and admin get a logger with their first BFF handler.
- Dependency rules: only `@repo/telemetry` imports OpenTelemetry; `ui` and `contracts` may not import it; web and admin only from `instrumentation.ts`, server code and tests; it may not depend on application frameworks; automatic instrumentation, exporters, `sdk-node` and module-hooking packages are forbidden everywhere.

## `@repo/db` (server-only)

- `createDatabase({ connectionString, maxConnections })`: Kysely 0.29.5 on node-postgres (`pg` 8.23.0). Queries are sent as unnamed statements, so no named prepared statements reach a transaction-mode pooler. `pg-native` is not used.
- `withRlsContext(db, claims, work)`: runs `work` in one transaction after `SET LOCAL ROLE authenticated` and `set_config('request.jwt.claims', <claims JSON>, true)`. Both are transaction-local, so PostgreSQL restores the session state on commit, rollback or error. The claims must already be verified by the caller: this package never parses or verifies JWTs (authentication is Phase 3). It only checks that the claims are a plain JSON object with a non-empty `sub`, and sends them as a query parameter.
- Rules for work through the transaction pooler: everything that relies on the context uses the helper's transaction; no session-level settings, named prepared statements, `LISTEN/NOTIFY` or session advisory locks; default isolation; no statement timeout yet.
- `Database` and one interface per relation live in `src/schema.ts`. That file is **generated** from the applied migrations by `pnpm run db:types` and must never be edited by hand; CI fails when it and the migrations disagree.
- Not wired yet: `DATABASE_URL` in the API or worker, a `/ready` database check and any query path. Those arrive with the Phase 2 application steps.
- Dependency rules: the web and admin apps, `ui` and `contracts` may not import `@repo/db` or a database driver.
- `pnpm test` runs its unit tests only; no database is needed.

## Local Supabase stack and TOOL-3

- Supabase CLI 2.116.0 is a root dev dependency (its binary comes from a per-platform npm package; no install scripts). Run it only through `pnpm run supabase <command>`: every invocation sets `SUPABASE_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` and routes all outbound requests from the CLI process through a local proxy that refuses and records them. The CLI's latest-version check (`api.github.com`) is a reviewed, always-refused attempt; any other outbound attempt fails the command. Requests to the local stack (loopback) are not proxied. Docker image pulls are made by the Docker daemon.
- `supabase/config.toml` (generated by the CLI) uses project ID `marketplace`, PostgreSQL 17 and the connection pooler in transaction mode (port 54329, 20 server connections per user and database, 100 client connections). `supabase/migrations/` holds the Phase 2 migrations (see "Database schema"). Local CLI state (`supabase/.temp/`) is not committed. The stack needs Docker.
- `toolchain/supabase-images.json` is the image digest lock. It is `pending-owner-approval`: image digests, the services that may be excluded and the pooler user format are discovered only by the manual `supabase-images-record` workflow, reviewed by the owner, and then committed with `status: approved` (see "CI"). Nothing is trusted on first use. `pnpm run supabase:images verify` (running containers) and `verify-transient` (the pg_prove image) fail while the lock is not approved or when an image does not match.
- `pnpm run tool3` (TOOL-3) needs the running local stack and two variables: `TOOL3_POOLER_URL` (the pooler, port 54329, user `tool3_app_api`, optionally tenant-qualified, no password) and `TOOL3_ADMIN_URL` (the direct database connection, port 54322, with credentials). Values must point to loopback and are never printed. The command fails closed if the configuration, the stack, the image digests or the variables are not as required; it never uses another database. It creates throwaway fixtures (`packages/db/test/fixtures/`: schema `tool3`, login role `tool3_app_api` with a random per-run password and `authenticated` membership `WITH INHERIT FALSE, SET TRUE`, one table with an RLS policy) and removes them afterwards. It runs 50 concurrent transactions for 20 rounds with random delays, including deliberate rollbacks and errors, and checks that each transaction sees only its own claims and rows, that reused server connections show no leftover role or claims afterwards, that there are no prepared-statement errors, that the fixture role alone has no table access and that no claims means no rows. On success it prints "Local transaction-pooler behavior verified". **TOOL-3 has not run yet: it is pending CI (Docker).** In CI, `scripts/ci/supabase-local.mjs tool3` derives both values at runtime from `supabase status -o env` and the approved pooler user format; nothing is written to files or logs.
- `pnpm run db:supplemental` runs the same scenario against plain PostgreSQL behind PgBouncer (`SUPPLEMENTAL_POOLER_URL`, `SUPPLEMENTAL_ADMIN_URL`). It is sandbox supplemental evidence only: **not TOOL-3, not Supabase, not Supavisor.**
- `pnpm run test:tooling` also tests the configuration reader, the CLI request review, the image-lock approval rules and the CI helpers.

## Database schema (Phase 2)

`supabase/migrations/` holds the numbered migrations of the v5.2 migration plan. Files are named
`NNNN_lower_snake_case.sql`, versions are contiguous from `0001`, and every file opens with its own
`-- NNNN — ` header. `pnpm run check:migrations` enforces all of that, plus: every table a migration
creates has row level security enabled by some migration, every `SECURITY DEFINER` function pins
`search_path`, nothing is ever granted to `anon`, and no password literal appears in a migration.

Committed so far (Phase 2 Steps 1 and 2):

| # | Contents |
| --- | --- |
| 0001 | Extensions (pgcrypto, citext, pg_trgm, unaccent, postgis, pg_cron, Vault), schemas `app_private` and `audit`, the privilege baseline and the shared trigger and claims helpers |
| 0002 | `locales`, `currencies`, `currency_translations`, `countries`, `listing_types`; currency immutability, retirement and the D16 dependency registry |
| 0003 | `roles`, `permissions`, `role_permissions`, `user_roles`; the `app_api`/`app_system`/`app_worker` database roles; `has_permission`, `has_role`, `is_aal2`, `is_verified_seller`; the access-token hook |
| 0004 | `app_private` auth security state (OTP challenges, password resets, rate limits, login attempts, lockouts) plus `known_devices`, `security_events`, `step_up_grants` |
| 0005 | `profiles` (synced from `auth.users`), `user_settings`, `addresses`, `user_blocks` |
| 0006 | `audit.audit_logs` (monthly partitions, append-only) and the generic audit trigger |
| 0007 | Transactional outbox, idempotency keys and job runs |
| 0008 | `site_settings`, `email_templates`, `email_outbox`, `whatsapp_outbox` and the delivery functions |
| 0009 | `seller_profiles`, `seller_verifications`, `seller_verification_documents`, `shipping_profiles`, `shipping_zones`, `shipping_rates` |
| 0010 | `categories` (one tree, three levels, D8), `category_translations`, `attribute_definitions`, `attribute_options`, `category_attributes`, `tags` |
| 0011 | `listings`, `listing_product_details`, `listing_attribute_values`, `listing_tags`, `listing_slug_history`, `listing_status_history`, `listing_media`, `media_variants`; search vectors and geography |

### Privilege model

Requests reach data the way `withRlsContext` does it: connect as `app_api`, then `SET LOCAL ROLE
authenticated` inside one transaction with the verified claims. `app_api` is a `NOINHERIT` member of
`authenticated` with `SET TRUE` (owner decision S8), so it holds nothing of its own; the table
privileges the request actually uses belong to `authenticated`, and row level security decides what it
sees. `app_system` and `app_worker` hold no table privileges at all and act only through named
`SECURITY DEFINER` functions. `anon` is granted nothing anywhere — not even schema usage — and the Data
API stays off (`auto_expose_new_tables = false`, `pg_graphql` never installed).

> **Spec note for the owner.** v5.2's exposure table says "`anon` and `authenticated` hold no privileges
> on any table in `public`, `app_private`, `audit`", but S6/S8 and the approved TOOL-3 fixture require a
> request that has done `SET LOCAL ROLE authenticated` to be able to read its own rows, which is only
> possible if `authenticated` carries the grants. The implementation follows S6/S8 and the fixture:
> `anon` holds nothing, `authenticated` holds only explicitly granted privileges on `public` tables that
> have RLS and at least one policy, and holds nothing in `app_private`. The pgTAP guard asserts exactly
> that. Confirm or correct this reading when convenient; nothing else depends on the wording.

### Visibility, media and search

A listing's public surface follows one decision, `public.listing_is_visible()`, which combines listing
state and seller state; `listing_status_is_public`, `..._is_purchasable` and `..._is_indexable` express
the rest of the state table. Sold, expired and archived listings stay reachable with "No longer
available" (D2, N7) but cannot be bought and are not indexed; rejected, suspended and deleted listings
return 404; nothing of a suspended seller is public.

Media follows the same decision. Originals stay in a private bucket and are never served publicly, a
variant may never point at the original object, and a variant can only be public while its listing is
visible. Leaving the visible set withdraws the public variants and publishes a `listing.withdrawn`
outbox event so the worker deletes the objects and invalidates the public cache; entering it publishes
`listing.published` (C11 revalidation). Slug changes are recorded in `listing_slug_history` for the 301
redirects, and a slug that ever belonged to another listing can never be taken again.

Search uses PostgreSQL full text with language-aware `tsvector` columns for English and Arabic,
generated from the title and description, plus `pg_trgm` on the title for typo tolerance and PostGIS for
distance. The ranking formula and promoted-slot merge are Phase 9 decisions and are not implemented.

### Not built yet, on purpose

`mfa_backup_codes` is conditional on O-1 and its behaviour (D9) is blocked by the AUTH-4/AUTH-5 spikes,
so it is not created. The access-token hook exists but is not enabled in `supabase/config.toml`: wiring
it in belongs to Phase 3, with owner Decision 1 and AUTH-10. Image variant sizes and formats are a
Phase 4 proposal, so `media_variants.variant_key` is free text rather than a fixed set. Service detail
tables, offers and quotes arrive with migration 0015; storage buckets and their policies with 0012.

### Running the schema locally

- With Docker: `pnpm run supabase start` applies the migrations, and `pnpm run supabase test db --local`
  runs the pgTAP suite in `supabase/tests/`. This is the authoritative path and the one CI uses.
- Without Docker: `SUPPLEMENTAL_SCHEMA_URL=... pnpm run db:schema --baseline --reset --tests` applies the
  same files to a plain PostgreSQL server after creating a minimal Supabase-shaped baseline
  (`scripts/db/sandbox-baseline.sql`: the `auth`, `extensions` and `vault` schemas, the
  `anon`/`authenticated`/`service_role` roles and a stand-in `auth.users`). It is **sandbox supplemental
  evidence only — not Supabase, not CI evidence**, and the baseline file is never a migration.
- `DATABASE_TYPES_URL=... pnpm run db:types` regenerates `packages/db/src/schema.ts` from the applied
  schema. In CI, `scripts/ci/supabase-local.mjs types` performs the same comparison against the local
  stack and fails on drift.


## CI (GitHub Actions, Phase 1 Step 9)

The repository and its workflows are created and run by the owner; nothing here has been executed on GitHub yet. **TOOL-3, TOOL-7, B10-local and Gate B stay pending until real GitHub Actions runs provide the evidence.**

Workflows (`.github/workflows/`), all on `ubuntu-24.04`, with `permissions: {}` at the top and `contents: read` per job, no secrets, no GitHub Environments, no `pull_request_target` or `workflow_run`, `persist-credentials: false`, a timeout on every job and no automatic test retries. Every job starts with `actions/setup-node` for Node.js 24.21.0 and then checks that `node --version` prints `v24.21.0` (I2). pnpm comes from `pnpm/action-setup` (the `packageManager` field) and is checked to be 12.4.2. All actions are pinned to full commit SHAs (`toolchain/github-actions.json`): actions/checkout v7.0.1, actions/setup-node v7.0.0, pnpm/action-setup v6.1.0, actions/cache v6.1.0 (restore/save), actions/upload-artifact v7.0.1. `pnpm run check:policy` enforces all of this.

- `ci.yml` (pull requests to main, pushes to main, manual):
  - `policy`: frozen install with the dependency files hashed before and after, workspace integrity, workflow policy, install-script policy, 14-day package age (pnpm-managed packages only), `check:env`, currency literals.
  - `security`: gitleaks 8.30.1 over the full git history and the working tree (redacted), osv-scanner 2.6.0 over `pnpm-lock.yaml`. Both tools are downloaded from their GitHub releases and checked against `toolchain/security-tools.json`.
  - `lint-typecheck`: ESLint and strict type checking.
  - `build-test`: redis-server from Ubuntu 24.04 apt (must report 7.0.15; the tests start and stop their own servers, so no service container), uncached build, dependency boundaries (TOOL-6), generated-file drift (TOOL-2), client-bundle environment check, all tests (unit, Supertest API, Redis-down, TOOL-5), tooling tests, TOOL-4 negative control, unchanged dependency files and tracked files.
  - `tool1` (web and admin): TOOL-1 with the pinned Deno and the deny-all proxy, on every pull request.
  - `supabase-local`: starts the local stack with the approved images and exclusions, then TOOL-3, B10-local and TOOL-7 pgTAP, then stops it. It fails until the owner approves the image lock.
  - `e2e`: TOOL-7 Playwright smoke tests (Chromium only) against the built apps.
- `supabase-images-record.yml` (manual only): discovery for owner review (below). It never changes the repository.
- `scheduled-security.yml` (weekly on main, and manual): gitleaks, osv-scanner and the package-age check. Scanning only.

Caching: only the pnpm store, keyed by the lockfile hash. Pull requests restore it; only pushes to main save it. No Turbo remote cache and no other cache service.

Artifacts (kept 14 days) are sanitised JSON only: TOOL-1, TOOL-3, B10-local, TOOL-7 (pgTAP and Playwright), osv-scanner, gitleaks (rule, file and line; no secret values), package age, the Supabase image proposal and a tool/version summary per job. They never contain `.env` files, passwords, credentials or credential-bearing URLs, raw logs, database dumps, build directories (`.next`, `.netlify`, `dist`) or Deno binaries.

Network: Deno (TOOL-1) and the Supabase CLI run behind the deny-all proxy with their reviewed, always-refused requests; any other attempt fails. Docker image pulls are made by the Docker daemon and are checked against the approved digests.

### Deferred checks (not in the Phase 1 workflow)

These v5.2 pipeline stages need outputs that Phase 1 intentionally does not have. They are absent rather than simulated, and become mandatory when that surface exists:

| Stage | Why it is not in Phase 1 | Introduced |
| --- | --- | --- |
| Migrations from zero, migration safety checks | No real migrations (`supabase/migrations/` holds only `.gitkeep`); B10-local proves the CLI migration mechanism with a temporary migration | With the first real migration (Phase 2) |
| Full RLS matrix (aal1/aal2) | No application schema or policies | Phase 2 |
| Private-bucket check, no-exposed-schema check | No storage buckets and no application schema; "application schema" is defined with the Phase 2 schema | Phase 2 (mandatory, failing the build) |
| Kysely type drift | Owner decision S17 | Phase 2 |
| Idempotency tests | No business operations | With the first idempotent operation |
| OpenAPI breaking-change detection | Only the health contract exists (owner decision E20) | With the first real `/v1` API |
| Playwright critical E2E flows | Phase 1 has only the smoke surface | With the flows (later phases) |

### Supabase image digests and TOOL-3 values (owner approval required)

1. The owner runs the `supabase-images-record` workflow. It starts the stack with every excludable service excluded (supavisor and postgres are never excluded), discovers which pooler user format connects (`{role}`, `{role}.pooler-dev` or a tenant reported by the CLI) using a temporary probe role, runs TOOL-3, B10-local and pgTAP as discovery runs (not TOOL-3), and records the image digests including the pg_prove image. If that fails, it repeats everything with no exclusions.
2. The workflow uploads `supabase-images-proposal.json`: every attempt, its results and a proposed lock. Nothing is written to the repository.
3. The owner reviews the digests, exclusions and pooler user format and commits them to `toolchain/supabase-images.json` with `status: approved`, `approvedBy` and `approvedOn`.
4. From then on, `ci.yml` first pulls every approved image by its digest and tags it with the reference the CLI uses (so only approved content can start; the pg_prove image is pulled the same way before pgTAP), starts the stack with exactly those exclusions, and fails on any unapproved image or digest found afterwards. TOOL-3 connection values come from `supabase status -o env` at runtime and are never printed.

### Security exceptions

- osv-scanner: every known vulnerability fails the job. The only exception mechanism is an entry in `policy/osv-exceptions.json` with the exact id, package, version, ecosystem, justification, approver, approval date and expiry. Expired or incomplete entries fail the job; unused entries are reported for removal.
- 14-day rule: the default for all pnpm-managed packages (not for GitHub Actions, Node.js, pnpm itself, standalone tools or Docker images). An urgent security fix younger than 14 days needs an owner-approved, temporary entry in `policy/release-age-exceptions.json` (package, version, advisory, reason, approver, dates) and the same `package@version` in `pnpm-workspace.yaml` `minimumReleaseAgeExclude`. The check fails if the two lists differ or an entry has expired. There is no permanent bypass.
- Currency literals: uppercase ISO 4217 codes (`policy/iso4217-currencies.json`, 178 codes from the Debian iso-codes data) as whole tokens, via the TypeScript syntax tree for code and line by line for other text files. Migrations, seeds, tests and Markdown are excluded; any other exception needs a reviewed entry with a reason in `policy/currency-literal-allowlist.json`. Currency symbols are not part of the rule.

### Dependency updates

Two separate policies govern dependency updates:

- **GitHub Actions (Dependabot):** `.github/dependabot.yml` enables Dependabot version updates for the `github-actions` ecosystem only: weekly, one group for all actions, a **14-day cooldown** (`cooldown.default-days: 14`), at most 5 open pull requests, no auto-merge. Actions stay pinned to full commit SHAs (Dependabot pull requests update the SHA and its version comment), and every update is reviewed by hand before merging. `scripts/policy/workflow-policy.mjs` requires exactly this configuration.
- **pnpm-managed dependencies (not Dependabot):** GitHub documents Dependabot support for pnpm v7-v10, and pnpm 11+ lockfiles are reported as unparseable, so Dependabot does **not** manage pnpm dependencies in this pnpm 12.4.2 repository. They are updated manually and remain governed by the separate 14-day pnpm `minimumReleaseAge` policy (`pnpm-workspace.yaml`, checked by `scripts/policy/package-age.mjs`), with the audited exception process above for urgent security fixes.

Dependabot alerts may be enabled as a repository setting but are not relied on for `pnpm-lock.yaml`; osv-scanner is the authoritative Phase 1 dependency vulnerability scan.

**Security overrides.** When an osv-scanner finding cannot be fixed by an in-range upgrade, the patched version is pinned with a pnpm override in `pnpm-workspace.yaml` and documented in `policy/dependency-overrides.json` (advisories, dependency path, reason, upstream status, review date). `scripts/policy/integrity.mjs` requires every override to be an exact version and to match the register in both directions. Overrides are temporary security fixes, not dependency upgrades, and they obey the same 14-day rule as any other package. Current entries: `js-yaml 4.3.2` (GHSA-2883-xcg3-v3hh; orval pins 4.3.1 exactly), `sharp 0.35.4` (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c; `ipx` declares `^0.34.3` and no stable upstream fix exists) and `toml 4.3.0` (GHSA-v5mp-jgw5-2x6j, GHSA-82x6-q7mm-w9cf; netlify-cli declares `^3.0.0`, and upgrading the CLI does not remove the vulnerable copy).

### GitHub repository settings (configured by the owner)

These are not enabled by anything in this repository:

- A ruleset on `main`: no direct pushes, pull requests required, at least one approving review, required status checks: every `ci.yml` job, selected by the display names shown in GitHub (the `name:` of the policy, security, lint-typecheck, build-test, both TOOL-1, supabase-local and e2e jobs), no force pushes or deletion.
- Secret scanning and push protection.
- Dependabot alerts (informational only for pnpm, see above) and Dependabot version updates for Actions.
- Actions settings: allow only the actions listed above (by SHA), default `GITHUB_TOKEN` permission read-only, approval required before running workflows from forks.

### Reproducibility

Node.js, pnpm, the lockfile, Deno, gitleaks, osv-scanner, the Playwright browser build (Chrome for Testing 151.0.7922.34, Playwright revision 1234, `toolchain/ci-system.json`) and, once approved, the Supabase images are pinned and verified in each run. GitHub-hosted runner images and Ubuntu apt packages are not digest-pinned; the Redis version and all tool versions are checked instead and recorded in the version summaries.

### Gate B evidence

Gate B remains open until the owner provides real results: the GitHub repository, green `ci.yml` runs on a pull request and on main with Node.js 24.21.0, TOOL-1 to TOOL-7 (TOOL-3 recorded as "Local transaction-pooler behavior verified"), B10-local, the security, boundary, secret and currency checks, tests and builds, the tooling checks, the approved image lock, and the sanitised artifacts. Netlify runtime telemetry behaviour is outside Gate B and stays pending.

## TOOL-1 and the pinned Deno toolchain

`pnpm run tool1` runs `netlify build --offline --filter @repo/<app>` **from the repository root** for both apps.

Netlify resolves its paths against the git repository root, so running the build inside an app folder writes the runtime outputs to a doubled path (`apps/web/apps/web/.netlify/...`) and TOOL-1 fails with missing outputs. This only happens in a real checkout, which is why a sandbox without `.git` passed while CI failed. Each app's `netlify.toml` therefore uses a repository-root-relative `publish` (`apps/<app>/.next`) and a package-scoped command (`pnpm --filter @repo/<app> run build`), so the app's own build runs and never the root workspace build.

Four guards (`scripts/toolchain/tool1-guards.mjs`, tested by `scripts/toolchain/tool1-guards.test.mjs`) stop TOOL-1 from passing for environment-specific reasons: the resolved `publish`, `packagePath` and `buildDir` must match this app and the repository root; no doubled `.netlify` output path may exist (the repository-relative copy inside the packaged function bundle is not flagged); with `.git` present Netlify's `repositoryRoot` must equal the repository root (recorded in the result either way); and the log must show the package-scoped build command and no root `turbo run build`.

Netlify's edge bundler needs Deno, which is governed as a pinned external toolchain (not a pnpm package):

- `toolchain/deno.json` pins Deno 2.9.6 (released 2026-08-27; the bundler requires `>=2.4.2 <3`), the release archive SHA-256 and the binary SHA-256.
- `pnpm run toolchain:deno` downloads the archive from the official GitHub release into `~/.cache/marketplace-toolchain` (or `MARKETPLACE_TOOLCHAIN_DIR`, which must be outside the repository), verifies both hashes and the exact `--version` line, and fails closed on any mismatch. It never replaces an existing different installation. Linux x64 only; requires `unzip`.
- The runner puts the pinned Deno first on `PATH`, uses fresh empty `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `DENO_DIR` directories, sets `DENO_NO_UPDATE_CHECK=1`, and routes all outbound traffic through a local proxy that refuses and records every request. It fails if Netlify downloads or caches Deno, if the pinned Deno was not used, if build output is missing, or if any unreviewed outbound request is attempted.
- Reviewed and blocked requests: `edge.netlify.com` (an unversioned module imported by the bundler's config extractor, `https://edge.netlify.com/bootstrap/globals/types.ts`, plus a types version check), the Netlify plugin list and the post-build prewarm of placeholder deploy URLs. Because the extractor cannot load, the runner verifies that nothing was lost: the bundled edge manifest's routes and function config must match the Next.js runtime's `manifest.json`, generated edge entries may export only a default handler, and the bundle must match its content hash. `pnpm run test:tooling` tests this verifier.

## `@repo/worker`

- NestJS standalone context running BullMQ 6 directly (no `@nestjs/bullmq`), ioredis 6 client. No business queues yet; jobs, outbox relay and reconciliation come in later phases.
- Environment: `NODE_ENV` (required), `LOG_LEVEL` (default `info`), `REDIS_URL` (required; `redis://` only in development/test, production needs `rediss://` with a password; never logged), `WORKER_CONCURRENCY` (default 5), `WORKER_HEALTH_HOST` and `WORKER_HEALTH_PORT` (required), `WORKER_SHUTDOWN_TIMEOUT_MS` (default 25000).
- Redis: queue keys use the `queue` prefix. The worker refuses to start unless `maxmemory-policy` is `noeviction` (checked with `CONFIG GET`, falling back to `INFO memory`; unverifiable means refusal) and stops with exit code 1 if a reconnected Redis fails the check. If Redis is unavailable at start-up the worker keeps retrying (capped backoff, 200 ms steps up to 5 s) and reports not ready.
- Jobs carry IDs only: `<name>Id` keys with UUID values. Other payloads are refused when enqueued and dead-lettered without retry if they reach a worker.
- Retries: 5 attempts, exponential backoff 1 s, 2 s, 4 s, 8 s, each shortened by a random jitter of up to 20 %.
- Dead-letter: after the last attempt the job is stored in `<queue>-dead-letter` (source queue, job ID, job name, attempt count, IDs-only data, error type; never the error message or stack), a `dead_letter` error log event is written, and the failed job is removed. Entries older than 14 days are purged hourly.
- Retention: completed jobs 24 hours, at most 1,000.
- Internal health server (Node `http`): `GET /health` (process) and `GET /ready` (Redis ping, `noeviction` verified, workers running). Everything else is a 404 problem response.
- Graceful shutdown on SIGTERM/SIGINT: stop fetching jobs, wait for active jobs up to `WORKER_SHUTDOWN_TIMEOUT_MS`, then close (forced only if jobs are still running; they are retried later by BullMQ), close Redis and exit with code 0. If Redis is down, the worker does not wait.
- `msgpackr` (used by BullMQ) runs in pure-JavaScript mode: its install script is blocked and its native acceleration is switched off before BullMQ loads.
- Logs are JSON (pino, synchronous output); Redis URLs and passwords are redacted and error logs carry the error type, not the message.
- Tests start their own throwaway `redis-server` processes, so the Redis server binary must be on `PATH` (or set `REDIS_SERVER_BIN`).

## `@repo/contracts`

- Zod schemas for health, readiness and problem details (and nothing else yet).
- `openapi/openapi.json`: OpenAPI 3.1 (title `API`, version `0.0.0`) generated from the schemas with `@asteasolutions/zod-to-openapi`.
- `src/generated/api-client.ts`: fetch client generated by Orval from that document; call `configureApiClient({ baseUrl })` before use.
- `pnpm run generate` regenerates both files deterministically; `pnpm run check:generated` fails if the committed files are out of date.
- Contracts never import NestJS or Fastify (enforced by dependency-cruiser).

## `@repo/money`

- Amounts are signed whole numbers of the currency's minor unit, held as `bigint`, limited to the PostgreSQL `bigint` range. No floating point is used.
- No currency is built in. Currency definitions (ISO 4217 code and 0–4 decimal places) are passed in at runtime from the currencies table; currencies are never mixed and there is no conversion.
- Rounding (D14): half away from zero (`-1.5 → -2`).
- Percentages: decimal strings with up to 6 decimal places (`"14"` means 14%).
- Splits: largest remainder; parts always add up exactly. Equal remainders go to the larger weight, then the earlier position. Weights are whole numbers ≥ 0 with at least one above 0. Negative totals are split by absolute value and negated.
- Decimal input with more places than the currency allows is rejected, never rounded.
- JSON: `{ "amountMinor": "<whole number as a string>", "currency": "<ISO code>" }`, read strictly.
- Display formatting is not part of this package yet.

## `@repo/shared-types`

Only `Locale = 'en' | 'ar'` and `TextDirection = 'ltr' | 'rtl'`.

## `@repo/config`

Neutral design tokens: exactly two replaceable brand colours (`brandPrimary`, `brandSecondary`, currently grey placeholders), a neutral grey scale, the operating system font stack, and spacing, radius and type-size scales. No gradients or glows. The Tailwind preset comes with the Next.js step.

## Boundary rules (dependency-cruiser)

- `packages/*` must never import from `apps/*`.
- An app must never import from another app.
- `packages/contracts` must never import NestJS or Fastify.
- No circular dependencies; every import must resolve.

## Toolchain and version policy (O-22)

Toolchain pins: Node.js 24.21.0 (`.nvmrc`, `engines.node`), pnpm 12.4.2 (`packageManager`).

Root development pins: TypeScript 6.0.3, Turborepo 2.10.12, dependency-cruiser 18.2.0, @types/node 24.13.3, Vitest 4.1.11, fast-check 4.9.0.

Telemetry pins: @opentelemetry/api 1.9.1 (also in web and admin, where Next.js uses it); @opentelemetry/sdk-trace-node 2.11.0; @opentelemetry/resources 2.11.0; @opentelemetry/semantic-conventions 1.43.0. Web and admin: server-only 0.0.1.

Database pins: kysely 0.29.5; pg 8.23.0; @types/pg 8.23.1. Root: supabase 2.116.0.

Web and admin pins: next 16.3.4; react and react-dom 19.2.8; next-intl 4.14.2; lucide-react 1.39.0; tailwindcss and @tailwindcss/postcss 4.3.3; postcss 8.5.26; @types/react 19.2.18; @types/react-dom 19.2.5; @netlify/plugin-nextjs 5.15.13. Root: netlify-cli 27.4.2.

Lint and end-to-end pins (Step 9): eslint 10.9.1; typescript-eslint 8.69.0; @next/eslint-plugin-next 16.3.4; eslint-plugin-react-hooks 7.1.1 (eslint-config-next and eslint-plugin-react are not used: the former requires eslint-plugin-react, which does not support ESLint 10, and ESLint 9 is no longer supported). `@repo/e2e`: @playwright/test 1.62.1. Adding them resolves Next.js's optional peers `@babel/core` 7.29.7 and `@playwright/test` 1.62.1 (approved; Next.js stays 16.3.4 and the web build and tests are unchanged).

Worker pins: bullmq 6.3.4; ioredis 6.0.0; pino 10.3.1; plus the NestJS, reflect-metadata, rxjs, zod, @swc/core and unplugin-swc pins shared with the API.

API pins: @nestjs/common, @nestjs/core, @nestjs/platform-fastify and @nestjs/testing 12.0.1; fastify 5.12.1; @fastify/helmet 13.1.1; reflect-metadata 0.2.2; rxjs 7.8.2; zod 4.5.4; supertest 7.2.2; @types/supertest 7.2.1; unplugin-swc 1.5.11; @swc/core 1.16.1.

Contracts pins: zod 4.5.4; @asteasolutions/zod-to-openapi 9.1.0; orval 8.27.0.

Stabilization window: 14 calendar days for direct and indirect packages installed and managed by pnpm, enforced by `minimumReleaseAge: 20160` (minutes) in `pnpm-workspace.yaml`. Each such pin is the newest release that was at least 14 days old when selected on 2026-09-16. The window does not apply to the Node.js runtime or the pnpm `packageManager` pin, which are governed separately.

Install scripts: `allowBuilds` blocks every install script in the dependency graph: `@swc/core`, `esbuild` (an Orval dependency), `msgpackr-extract` (a BullMQ dependency), and `netlify-cli`, `@parcel/watcher` and `unix-dgram` (Netlify CLI dependencies). `sharp` was listed until Step 9: it reached the tree through `ipx` as 0.34.5, which had an `install` script, and the approved security override to 0.35.4 (which has no install lifecycle script and no `binding.gyp`) made the entry stale. The policy rejects stale entries as well as unlisted install scripts, so if a future version of any package reintroduces one, the check fails until it is blocked again. `@swc/core` and `esbuild` work from their prebuilt platform packages; `msgpackr` runs in pure-JavaScript mode; the Netlify CLI runs without its install scripts. `pnpm peers check` reports two peer mismatches inside the Netlify CLI's own dependencies (`@netlify/blobs`, `@opentelemetry/api`); they are reported, not overridden.

CI must fail unless `node --version` prints `v24.21.0`; `engines` alone does not enforce this.

Node.js 24 moves to Maintenance on 2026-10-20 and Node.js 26 becomes Active LTS on 2026-10-28. The move to Node.js 26 is a planned O-22 upgrade (full CI and staging verification), never a silent change.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm run build`
- `pnpm run typecheck`
- `pnpm run test` (builds first; runs one package at a time because the worker tests measure timing; the API and worker tests start the built servers; the worker tests need `redis-server`)
- `pnpm run depcruise` (after a build: imports by package name resolve into `dist/`, which is recorded but not cruised)
- `pnpm run check:generated` (TOOL-2 generated files are current)
- `pnpm run tool4:negative-control` (TOOL-4: DI tests fail without SWC decorator metadata)
- `pnpm run test:tooling`
- `pnpm run check:env` (process.env boundary, .env files, README inventory table)
- `pnpm run check:client-env` (after building web and admin)
- `pnpm run tool1` (TOOL-1, both apps)
- `pnpm run tool3` (TOOL-3; needs Docker and the local Supabase stack)
- `pnpm run db:supplemental` (sandbox supplemental evidence; not TOOL-3)
- `pnpm run db:schema` (applies `supabase/migrations/` to a local PostgreSQL server; sandbox supplemental only)
- `pnpm run db:types` (regenerates `packages/db/src/schema.ts` from the applied schema)
- `pnpm run check:migrations` (migration naming, headers, RLS coverage, grants, pgTAP plans)
- `pnpm run supabase <command>` and `pnpm run supabase:images <verify|verify-transient>`
- `pnpm run lint`
- `pnpm run check:policy` (workspace integrity, workflow policy, install scripts, currency literals, migrations) and `pnpm run check:package-age` (needs the npm registry)
- `node scripts/security/gitleaks.mjs --summary <file>` and `node scripts/security/osv.mjs --summary <file>` (need the tool downloads; osv-scanner needs api.osv.dev)
- `pnpm --filter @repo/e2e run test:e2e` (after building web and admin and installing Chromium with `pnpm --filter @repo/e2e exec playwright install --with-deps chromium`)
- `pnpm run dev` in `apps/api` or `apps/worker` (after a build; loads `.env` if present)
