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
- Environment (validated at start-up; errors list variable names only): `NODE_ENV` (`development` | `test` | `production`, required), `API_HOST` (required), `API_PORT` (required), `LOG_LEVEL` (default `info`), `APP_SYSTEM_DATABASE_URL` (required, secret), `APP_SYSTEM_DATABASE_MAX_CONNECTIONS` (default `10`).
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
| `APP_SYSTEM_DATABASE_URL` | api | yes | — | yes | local, ci, staging, production | current | Server-only PostgreSQL connection string for the app_system role, which reaches the database only through named SECURITY DEFINER functions |
| `APP_SYSTEM_DATABASE_MAX_CONNECTIONS` | api | no | `10` | no | local, ci, staging, production | current | Upper bound of pooled app_system connections (1-500) |
| `OTP_PEPPER` | api | yes | — | yes | local, ci, staging, production | current | Server-only HMAC-SHA-256 pepper for OTP code digests (owner decision C-9); at least 32 bytes |
| `WAABEK_BASE_URL` | api | yes | — | no | local, ci, staging, production | current | Base URL of the Waabek WhatsApp delivery API (http or https, no credentials); https://waabek.com in production |
| `WAABEK_API_KEY` | api | yes | — | yes | local, ci, staging, production | current | Server-only Waabek API key sent as the X-API-Key header; never reaches a browser |
| `INTERNAL_BFF_CREDENTIAL` | api, web, admin | yes | — | yes | local, ci, staging, production | current | Server-only internal BFF credential presented as the x-internal-credential header (owner decision C-2d); 32 random bytes as base64url. The API accepts CURRENT,PREVIOUS during rotation; web and admin send one value and accept only a single credential |
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
- `toolchain/supabase-images.json` is the image digest lock. Image digests, the services that may be excluded and the pooler user format are discovered only by the manual `supabase-images-record` workflow, reviewed by the owner, and then committed with `status: approved` (see "CI"); the lock is **approved** (2026-09-18) and covers three images, including the transient `pg_prove` image that TOOL-7 and the hosted pgTAP run both use. Nothing is trusted on first use. `pnpm run supabase:images verify` (running containers) and `verify-transient` (the pg_prove image) fail while the lock is not approved or when an image does not match.
- `pnpm run tool3` (TOOL-3) needs the running local stack and two variables: `TOOL3_POOLER_URL` (the pooler, port 54329, user `tool3_app_api`, optionally tenant-qualified, no password) and `TOOL3_ADMIN_URL` (the direct database connection, port 54322, with credentials). Values must point to loopback and are never printed. The command fails closed if the configuration, the stack, the image digests or the variables are not as required; it never uses another database. It creates throwaway fixtures (`packages/db/test/fixtures/`: schema `tool3`, login role `tool3_app_api` with a random per-run password and `authenticated` membership `WITH INHERIT FALSE, SET TRUE`, one table with an RLS policy) and removes them afterwards. It runs 50 concurrent transactions for 20 rounds with random delays, including deliberate rollbacks and errors, and checks that each transaction sees only its own claims and rows, that reused server connections show no leftover role or claims afterwards, that there are no prepared-statement errors, that the fixture role alone has no table access and that no claims means no rows. On success it prints "Local transaction-pooler behavior verified". **TOOL-3 has not run yet: it is pending CI (Docker).** In CI, `scripts/ci/supabase-local.mjs tool3` derives both values at runtime from `supabase status -o env` and the approved pooler user format; nothing is written to files or logs.
- `pnpm run db:supplemental` runs the same scenario against plain PostgreSQL behind PgBouncer (`SUPPLEMENTAL_POOLER_URL`, `SUPPLEMENTAL_ADMIN_URL`). It is sandbox supplemental evidence only: **not TOOL-3, not Supabase, not Supavisor.**
- `pnpm run test:tooling` also tests the configuration reader, the CLI request review, the image-lock approval rules and the CI helpers.

## Database schema (Phase 2)

`supabase/migrations/` holds the numbered migrations of the v5.2 migration plan. Files are named
`NNNN_lower_snake_case.sql`, versions are contiguous from `0001`, and every file opens with its own
`-- NNNN — ` header. `pnpm run check:migrations` enforces all of that, plus: every table a migration
creates has row level security enabled by some migration, every `SECURITY DEFINER` function pins
`search_path`, nothing is ever granted to `anon`, and no password literal appears in a migration.

Committed so far (Phase 2 Steps 1 to 18) — Phase 2 complete:

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
| 0012 | Storage buckets, their public/private contract and the `storage.objects` policies |
| 0013 | `favorites`, `saved_searches`, partitioned `listing_events` and the monthly-partition helper |
| 0014 | `conversations`, `conversation_participants`, `messages`, `message_attachments`; the membership version (UB6) and the `realtime.messages` private-topic policy |
| 0015 | `listing_service_details`, `offers`, `offer_messages`, `service_requests`, `service_quotes` |
| 0016 | `tax_rules`, `commission_rules`, `commission_rule_amounts`, `cancellation_policies` and their resolvers |
| 0017 | `carts`, `cart_items`, `checkouts`, `checkout_items`, `checkout_charges`, `checkout_tax_lines`, `inventory_reservations` |
| 0018 | `orders`, `order_items`, `order_status_history`, `order_shipments`, `service_deliveries`, `order_cancellations`, the D12 reference sequences and `fulfil_checkout()` |
| 0019 | `payment_providers`, `payment_provider_capabilities`, `payments`, `payment_attempts`, `payment_provider_transactions`, `payment_events`, `refunds`, `refund_items`, `payment_disputes` |
| 0020 | `payment_exception_policies`, `payment_exception_cases`, `payment_exception_actions`, `payment_fee_allocations` and `settle_payment_attempt()` |
| 0021 | `ledger_accounts`, `ledger_journals`, `ledger_entries`, `seller_balances`, the `wallet_transactions` view, `withdrawal_limits`, `withdrawals`, `commissions`; `post_ledger_journal()`, `release_seller_holds()`, the withdrawal state machine and the `fulfil_checkout()` replacement that posts the capture journal |
| 0022 | `payout_providers`, `payout_provider_capabilities`, `payout_destinations`, `payouts`, `payout_transactions`, `payout_events`, `payout_reversals`; `create_payout()`, `settle_payout()` and the payout reversal journal |
| 0023 | `provider_settlements`, `provider_settlement_items`; `clearing_account_balance()`, statement import, matching, variance detection and the reconciliation journal behind the B1-C posting gate |
| 0024 | `coupons`, `coupon_amounts`, `coupon_usage`; `category_is_within()`, `coupon_check()`, `apply_coupon()` and `release_coupon_usage()` |
| 0025 | `promotion_packages`, `promotion_package_prices`, `promotion_package_placements`, `promotion_package_categories`, `promotion_refund_policies`, `promotion_ranking_settings`, `promotions`, `promotion_status_history`, `promotion_transactions`, partitioned `promotion_events`, `promotion_analytics`; the promotion lifecycle, the wallet purchase and the refund journal |
| 0026 | `reviews`, `review_replies`, the `seller_ratings` view; D13 uniqueness by key, eligibility, moderation and the publication reassessment |
| 0027 | `reports`, `moderation_actions`, `listing_moderation_actions`, `disputes`, `dispute_messages`, `dispute_evidence`; report triage, listing moderation and the order dispute lifecycle |
| 0028 | `support_tickets`, `support_messages`, `support_attachments`, `support_internal_notes`, `support_ticket_events`, `account_recovery_requests`, `account_recovery_evidence`, `account_recovery_approvals`; the ticket Realtime topic, the two-person recovery rule and the post-recovery security hold |
| 0029 | `notifications`; `create_notification()`, `attach_notification_email()`, `mark_notification_published()`, `mark_notifications_read()`, `unread_notification_count()` and the per-user Realtime topic the outbox announces them on |
| 0030 | `cms_media`, `pages`, `page_translations`, `page_slug_history`, `blog_categories`, `blog_tags`, `blog_posts`, `blog_post_translations`, `blog_post_tags`, `blog_post_slug_history`, `faqs`, `homepage_sections`, `banners`, `navigation_menus`, `navigation_items`, `seo_settings`, `seo_metadata`, `redirects`; the shared publication lifecycle, the canonical and redirect rules and `resolve_redirect()` |
| 0031 | `app_private.append_only_contract`; `rls_problems()`, `grant_problems()`, `anon_privilege_problems()`, `role_boundary_problems()`, `definer_problems()`, `view_security_problems()`, `append_only_problems()`, `security_contract_problems()` and the deploy-time `assert_security_contract()` |
| 0032 | `app_private.scheduled_job_contract`; `expire_due_offers()`, `expire_due_service_quotes()`, `expire_due_payment_attempts()`, `ensure_event_partitions()`, the `run_scheduled_job()` dispatcher, `cron_job_problems()` and the twelve pg_cron jobs |
| 0033 | Seed: locales, EGP, Egypt, listing types, the seven roles, the 82 enforced permissions, the admin/super-admin mapping, neutral branding and the D-item settings, and a fail-closed payment-exception policy per case type |

Phase 3 (authentication) starts here:

| # | Contents |
| --- | --- |
| 0034 | `app_private.record_login_attempt()`: the writer 0004 never had, applying the approved lockout rule (5 failed logins in 15 min → 15-min lock) |
| 0035 | OTP challenge lifecycle: `issue_otp_challenge()`, `verify_otp_challenge()`, `begin_otp_delivery()`, the `send_count`/`last_sent_at` resend state, and a repair to `rate_limit_hit()` |
| 0036 | Step-up grants from a verified OTP: `issue_step_up_grant()`, the `otp_whatsapp` grant source and one-grant-per-challenge |
| 0037 | Consuming a step-up grant: `consume_step_up_grant()`, the single atomic authorisation primitive (C-19) |

### Authentication (Phase 3, Step 1)

**Owner Decision 1 (UB5) is resolved as Option B: all authentication operations stay behind NestJS.**
The trust boundary is `Browser → NestJS/BFF → Supabase Auth`. The browser never performs a Supabase Auth
operation directly and never holds a Supabase access token as the application's authentication
mechanism; NestJS is the enforcement point. That decision is what the code in `apps/api/src/auth/` is
shaped around, and it is recorded here because it constrains every later authentication step.

Step 1 implements one thing: the durable lockout gate that AUTH-3 / N1 requires to run *before* any
Supabase call.

> NestJS enforces durable lockout before any Supabase call

0004 created `app_private.login_attempts` and `app_private.account_lockouts` but gave nothing a way to
write them, and the 0031 role-boundary contract forbids granting `app_system` table privileges. 0034 adds
the missing writer as a `SECURITY DEFINER` function granted to `app_system` alone, so the tables stay
unreachable and the function is the only door. The threshold, window and lock duration come from the
approved decision row — "5 failed logins in 15 min → 15-min lock" — and are fixed inside the function
rather than passed in, so no caller can weaken the policy.

`LoginEnforcementService` fails closed in both directions: an unreachable database denies the attempt
instead of allowing it, which is what "never fails open for auth" means in practice. Identifiers and user
agents are SHA-256 hashed before they reach the database, so a leak of the attempt log is not a leak of
the addresses that were tried. Every error carries one generic message, because the login flow ends with
"Generic error message always" and a distinguishable lockout error would answer the question of whether
an account exists.

### The `/v1` boundary and the internal BFF credential (C-2d)

> Every `/v1` route except webhooks, hooks and health checks requires the internal BFF credential; user
> authentication and authorization are checked separately on every request.

The BFF presents `x-internal-credential` on every `/v1` call. `INTERNAL_BFF_CREDENTIAL` holds 32 random
bytes as base64url, generated out-of-band — never by application code, never committed, never stored in
PostgreSQL and never in a migration. For rotation the API accepts `CURRENT,PREVIOUS`; the BFFs send only
`CURRENT`, so a credential can be replaced without downtime: add the new value as `CURRENT` keeping the
old as `PREVIOUS`, deploy the API, move the web and admin runtimes to the new value, deploy them, drop
the old value, deploy the API again.

**What this credential is not.** It is an extra boundary and nothing more. It never authorizes a user
action, and the guard deliberately attaches nothing to the request, so no later handler can mistake it
for a principal. Without a valid user token only public endpoints may respond; token signature, expiry,
issuer, audience, `aal`, session state, role, permission, ownership and business rules are all checked
separately when those layers exist.

**Failure is uniform.** Missing, wrong and malformed credentials all produce the same **403** with the
generic `HTTP_ERROR` problem body and no `WWW-Authenticate` header, so a caller learns nothing from
which mistake they made. Comparison runs over SHA-256 digests with `timingSafeEqual`: fixed width, so
no branch depends on how long the real credential is, and every accepted value is compared so the work
done does not reveal which one matched.

The guard is registered with `APP_GUARD`, so it covers every `/v1` route by construction — including
ones added later by someone who forgets to decorate them — while `/health` and `/ready`, which live
outside `/v1`, pass straight through. The specification exempts webhooks and hooks, but none exist yet,
so the guard currently requires the credential on all of `/v1`: requiring it somewhere it will later be
exempt fails closed and is obvious the moment that route is built.

**Scope is decided by the route Fastify matched, not by the request URL.** The guard reads
`request.routeOptions.url` — the literal route pattern the router resolved — and treats any pattern
beginning `/v1` as protected, failing closed if no pattern is available. The first implementation
instead parsed the raw `request.url`, and that was **vulnerable**: Fastify's router percent-decodes path
segments before matching, so `GET /%76%31/foundation` resolved to `/v1/foundation` while the raw URL
still read `/%76%31/...`, the guard concluded the request was outside `/v1`, and the handler ran with no
credential. Reading the matched pattern removes the disagreement at its source, which is why there is
deliberately no decoding step here: reimplementing the router's normalization rules is what produced the
gap. `apps/api/test/v1-routing-normalization.test.ts` holds this closed with end-to-end HTTP tests that
prove encoded paths never reach the handler without the credential.

`GET /v1/foundation` is the only `/v1` route. It is a foundation probe — it reads no token, returns
`{"status":"ok"}` for every approved caller, and exists solely to prove the boundary. **It is not an
authentication endpoint and no authentication exists yet.**

The credential is declared for `api`, `web` and `admin`: the API enforces it and the two Next.js server
runtimes present it. It is declared for nothing else, and the env inventory and each app's configuration
module must agree, so a name cannot be listed for an app that does not read it.

**How web and admin send it.** Each app reads the credential in `src/server/config.ts`, the single
reader of the process environment, and `src/server/bff/` wraps `fetch` so that every call the generated
client makes carries the header. The credential is a closure variable inside that wrapper, and the
header is applied after the caller's own headers, so no call site can read it back or override it.
`@repo/contracts` accepts a `fetch` and knows nothing about the credential or the header — that is what
keeps a server-only secret out of the package the browser-facing code depends on. Every module under
`src/server/bff/` is `server-only`, so importing one from a client component is a build error.

Web and admin accept exactly one credential, while the API accepts `CURRENT,PREVIOUS`. That asymmetry is
the rotation procedure: the API tolerates both values during the changeover and the BFFs only ever send
`CURRENT`. A pair configured on a BFF would be sent as a single header value and refused on every call,
so it is rejected at start-up instead. A missing or malformed credential fails start-up the same way,
by name, before any request is made — the `start` preflight (R4-B) and the instrumentation hook both
enforce it.

### OTP challenges and WhatsApp delivery (Phase 3, Step 3)

This project owns the OTP; Waabek only carries the message. Waabek's own `/api/otp/send` and
`/api/otp/verify` are never used — the marketplace generates, hashes, expires and verifies the code
itself, and calls only the generic send endpoint.

**The delivery contract (owner-confirmed).** `POST {WAABEK_BASE_URL}/api/v1/send`, which is
`https://waabek.com` in production, with the header `X-API-Key: <server-side key>` and the body:

```json
{ "to": "<destination>", "message": "<OTP message>" }
```

Exactly those two fields. The origin comes from configuration rather than being hardcoded, so staging
and tests can point elsewhere, and `waabek.client.ts` is the only module permitted to call the provider.

**Where the clear code is allowed to exist.** Two contracts written before this step decide that, and
together they leave exactly one answer:

- `whatsapp_outbox` rejects the keys `code`, `otp`, `password`, `token` and `secret` in `variables`, so
  the code cannot go in the database.
- The worker's `assertIdPayload` restricts queue jobs to `<name>Id` keys with UUID values, so the code
  cannot go in a job either.

So the code never leaves the process that generated it: the API generates it, stores only its digest,
hands it to Waabek in the same call, and drops it. It is never written to PostgreSQL, never placed in
Redis, never logged, and never returned to the caller. That is why delivery happens in the API rather
than the worker, which the specification permits — "WABEK credentials | Worker (and API if needed)".

**The digest** is `HMAC-SHA-256(pepper, code)` (owner decision C-9). A six-digit code has only a million
possible values, so a bare SHA-256 would be exhausted instantly from a leaked table; the pepper lives
only in the API's configuration, never in the database, and `OtpPepper` redacts itself in string and
JSON conversion so it cannot reach a log by accident. The HMAC is computed in the application and only
the digest is sent to PostgreSQL, so a database compromise yields neither the code nor a way to forge
one.

**Limits and cooldown** are enforced in `issue_otp_challenge` before Waabek is contacted, so the
provider cannot be used to get around them: 5 sends per destination per hour, 10 per destination per
day, 20 per IP per hour, and the approved C-10 cooldown of 60 s after the first send, 120 s after the
second and 300 s thereafter. The tier never resets while the challenge lives. A resend replaces the code
on the *same* challenge and deliberately does **not** reset `attempts` — resetting it would turn the
five-attempt cap into five attempts per resend.

**Verification** happens inside one row-locked call, so the comparison, the attempt count and the single
consumption are atomic: two concurrent submissions of the same correct code cannot both succeed, and a
replay after consumption is refused.

**Every delivery failure is terminal for that message, and none consumes the challenge.** 4xx, 5xx, 429,
a timeout and an unreachable provider all settle the outbox row as `failed`. The row is never returned
to `queued`: the clear code is gone by the time the send returns, so a later relay attempt could only
send the wrong thing or nothing at all — a queued OTP row would be undeliverable by construction. The
challenge itself stays intact and unconsumed, and the person requests a new code through the approved
resend flow once the cooldown allows. `WaabekOutcome` carries no `retryable` flag and
`SettleOtpDeliveryInput.status` is narrowed to `sent | failed`, so the requeue cannot be written.

**A Phase 2 defect was repaired here.** `app_private.rate_limit_hit` declared a PL/pgSQL variable named
`window_start`, which shadowed the column of the same name in its `on conflict` clause; every call
raised 42702. No pgTAP test had ever invoked it and no application code had called it, so it had never
run once. It is the counter the approved OTP limits are built on, so 0035 replaces the function body —
the signature and the 0004 grants are unchanged, and no Phase 2 migration file was edited.

### Step-up grants (Phase 3, flow F5 — the "our OTP" half)

The specification requires a step-up grant "recorded in `step_up_grants` with a short validity" before a
password change, a payout-detail change, an account deletion or a revoke-all-sessions. Owner decision
C-16 sets that validity at **exactly 10 minutes**, which the schema could not supply: 0004 left
`expires_at` not-null with no default.

0004 also created the table with a read helper and no writer, so 0036 adds
`app_private.issue_step_up_grant()` — granted to `app_system` alone, with no table privilege anywhere
and the 0004 self-read RLS policy untouched.

**Verification and issuance are one call, deliberately.** If a caller could verify an OTP first and
record a grant afterwards, two concurrent requests could both observe "verified" before either wrote a
grant. Because the function calls `verify_otp_challenge` inside its own transaction, the single
consumption that function already guarantees *is* the event that authorises the grant. A partial unique
index on `challenge_id` is the second line of defence: no code path, present or future, can record two
grants against one challenge.

**A WhatsApp OTP is recorded as `otp_whatsapp`**, a value 0036 adds to the `granted_via` domain. It is
deliberately not mapped onto `otp_sms`: WhatsApp is not SMS, and the column exists to say truthfully how
someone proved themselves. `granted_via` is derived from the challenge's own channel rather than passed
in, so a caller cannot claim a stronger form of proof than they gave.

Anything other than a correct code on a live, unused challenge issues nothing — invalid, expired,
consumed, past the attempt ceiling, unknown, or a challenge that matched no account. A failed delivery
leaves the challenge unconsumed and no grant behind.

The TOTP half of F5 needs a live Supabase project and is not implemented.

### Spending a step-up grant (C-19)

A grant is single-use, and it is spent when the protected operation **succeeds** — not when it is
attempted. Those two rules pull in opposite directions, and the design is what reconciles them.

`app_private.consume_step_up_grant()` is one UPDATE carrying every condition in its WHERE clause: the
grant exists, belongs to this user, covers this operation, has not expired and has not been used. There
is no read-then-write, so there is no window in which two callers can both decide they may proceed.
Under READ COMMITTED a second concurrent UPDATE blocks on the row lock, re-evaluates its predicate
against the committed new version, finds `consumed_at` set, and matches nothing.

That alone would spend the grant on *attempt*. So the caller consumes and performs the operation in the
**same transaction**: if the operation throws, the rollback undoes the consumption and the grant is
available again; if it succeeds, the commit makes both permanent. The row stays locked until then, so a
concurrent attempt waits and succeeds only if the first one rolled back — which is "at most one
successful operation", not merely one attempt. `AppSystemStore.runWithStepUpGrant()` is that
transaction, and `StepUpService.authorize()` is its boundary.

Checking a grant is not spending it: `has_step_up_grant` is a read and consumes nothing.

The function returns a plain boolean. Distinguishing "wrong user" from "expired" from "already used"
would tell a caller about grants that are not theirs, and the authorisation answer is all they need.
`authenticated` keeps SELECT-only access, so a browser can see its own grants but can never mark one
spent; only `app_system` may execute the consumer.

No protected operation exists yet. Password change, payout-detail change, account deletion and
revoke-all-sessions will each call this primitive when they are built.

### Password policy (Phase 3, Step 2)

D1, approved, with the maximum revised by N2:

> Minimum 10 characters; maximum 72 UTF-8 bytes (measured in bytes, not characters, so Arabic and other
> multibyte text reaches the limit sooner); validated in UI and API before the password reaches the auth
> provider; no truncation; no normalization that changes meaning; exact comparison; no forced character
> mix

`PasswordSchema` in `packages/contracts` is the single definition of that rule. It lives there because
D1 requires it in the UI *and* the API, and `@repo/contracts` is the framework-free package all four
applications already depend on — so the web and admin apps validate against exactly the same rule the API
enforces, rather than a copy that can drift.

The two limits are measured in different units, which is the substance of the decision. The maximum is
72 **bytes** because bcrypt truncates there: a 72-character Arabic password is 144 bytes and would be
silently cut in half by the hasher, so it is rejected here instead. The minimum is 10 **characters**,
counted as Unicode code points rather than `String.length` — five emoji are ten UTF-16 code units, and
counting those would accept a five-character password. Byte length is measured with `TextEncoder`, not
`Buffer`, because `Buffer` does not exist in a browser and half of "UI and API" is the browser.

The schema validates and returns the value unchanged: no trim, no normalize, no transform, no
truncation. NFC and NFD forms stay distinct, surrounding whitespace is part of the password, and an
over-long password is rejected rather than shortened. Failures surface through the existing Phase 1
validation contract — 400 `VALIDATION_FAILED` with the field path — so this step introduces no new
status code, and the password never appears in a problem response.

Two parts of D1 are deliberately **not** implemented, because the specification does not define them:
**common-password blocking** (required, but no list, source or threshold is named anywhere) and
**leaked-password checking** (deferred to Supabase's feature "if available on the selected plan (O-3)",
and O-3 is OPEN; D1 adds that no other breach provider may be substituted silently). Both are owner
decisions, and nothing here approximates them.

Pending evidence: D1-1's final clause, "exactly-72-byte password verifies", has two halves. That the
validator accepts exactly 72 UTF-8 bytes is verified here. That Supabase then verifies such a password
requires a live Supabase project, which this environment does not have, so that half remains unverified.

Not built yet, deliberately, because the specification does not define them:

- **Login throttles.** The login flow says "durable lockout check (PostgreSQL) and throttles", but every
  numeric rate limit in the specification ("5/h and 10/day per destination; 20/h per IP") belongs to the
  OTP row. No limit is defined for password login. `app_private.rate_limit_hit()` exists and is granted,
  and stays unused until an owner decision supplies values.
- **HTTP status codes for authentication.** The specification defines none; there is no "423" or "429"
  anywhere in it. There is therefore no controller in this step, and the errors are typed rather than
  mapped to statuses.
- **Everything after the gate**: the Supabase sign-in itself, session cookies, TOTP and `aal2`, new-device
  detection. Those are later Phase 3 steps.

### The seed

0033 is reference and configuration data only. There is no user, seller, buyer, order, payment, payout,
ledger entry, review, dispute, ticket, listing, page or post in it, no password, OTP, token or provider
secret, and no staff account — an account is a person, and a person arrives through the authentication
flow, never through a migration.

Every statement is `insert … on conflict do nothing` on the row's natural key, or, for the one table with
a surrogate key, `insert … select … where not exists` on its natural key with a deterministic id derived
from `md5`. Nothing uses `do update`, which is what keeps the seed from overwriting a value an
administrator has since changed. Running it twice inserts nothing and updates nothing.

The immutable part of the seed is identity — which codes exist and what they are called: `EGP`, `EG`,
`en`, `ar`, `product`, `service`, the role keys and the permission keys. The configurable part is
everything with a flag or a number in it: which currency is enabled, which country is open, how long a
guest cart lives, how an exception is resolved. The first group is what the rest of the schema references
by key; the second is what the admin console exists to change.

The 82 permissions are derived, not invented: they are exactly the keys migrations 0001 to 0032 enforce
through `has_permission()`, and a pgTAP assertion compares the seeded set with the keys read out of
`pg_policy` in both directions. `admin` and `super_admin` hold all of them.

The authorization matrix describes the other two console roles in prose rather than by key — "All
moderation actions", "Assigned tickets, recovery review" — so their lists were left empty until the
owner settled them on 2026-09-20. They are now seeded exactly as authorized, key by key:

* **`moderator`** (9): `moderation.report.read`, `moderation.report.manage`, `moderation.action.read`,
  `catalog.listing.read`, `catalog.listing.moderate`, `reviews.review.read`, `reviews.review.moderate`,
  `users.profile.read`, `sellers.profile.read`. Disputes are a separate responsibility, so
  `disputes.dispute.read` and `disputes.dispute.manage` are withheld by decision.
* **`support_agent`** (5): `support.ticket.read`, `support.ticket.manage`, `security.recovery.review`,
  `users.profile.read`, `orders.order.read`. `users.security.read` and `sellers.profile.read` are
  withheld.

Neither grant widens anything. Ticket visibility stays where 0028 put it — `assigned_to =
current_user_id() or assigned_to is null`, ANDed with the permission and `is_aal2()`. And
`security.recovery.review` is read-only by construction: it appears in exactly three policies, all
`for select`, and the recovery actions live in `app_private` SECURITY DEFINER functions that
`authenticated` cannot execute, each refusing anyone who reviews, approves or completes their own
recovery, and refusing an approver who is the reviewer. No `security.recovery.approve` key was created.

Left unseeded on purpose, because the specification supplies no values: the other 177 ISO 4217
currencies (the committed reference file carries alphabetic codes only, and `decimal_places` drives every
money calculation), all countries but Egypt (`name_ar` is `not null` and D7 forbids machine translation),
the baseline taxonomy, tax and commission rates, cancellation policies, withdrawal limits, promotion
packages, email templates and CMS content, and the C18 retention periods.

Seeding reference data changed what the pgTAP fixtures may assume. Twenty-six test files were updated so
they coexist with the seed — test rows use test-only identifiers, a test that needs *the* default locale
or currency uses the seeded one, and a test that needs a canonical role uses the seeded role rather than
inserting a look-alike beside it. No assertion was removed or weakened.

### Scheduled jobs

The approved runtime split names exactly what belongs on pg_cron — promotion start and end, reservation
and attempt expiry, balance release after the hold, offer expiry, service auto-completion (D23),
analytics rollups and partition creation — and puts everything else on the worker. 0032 schedules that
list, plus 0030's due-content publication and 0031's nightly contract assertion. The **outbox sweeper is
deliberately not scheduled here**: the same table files it under worker repeatable jobs, so
`sweep_outbox_events()` stays callable and unscheduled. The **unverified-account purge is also absent**,
because the specification marks D24 "APPROVED conceptually; schedule depends on C18" and C18 is deferred
to before production — scheduling it would mean choosing a retention period a deferred decision owns.

Every cron entry has the same shape: `select app_private.run_scheduled_job('<key>')`. No entry holds
business logic, an inline statement, or a call the contract does not name, so the whole schedule can be
audited from `cron.job` alone — which is what the pgTAP file reads, rather than the contract table. The
dispatcher maps a key to a call through a `CASE` over literal keys and never executes text from a table,
so the contract stays data and never becomes code.

Every run opens and closes a `public.job_runs` row through 0007's recorders. Because pg_cron gives each
command its own transaction, a re-raised exception would roll back the very row that records the failure;
the dispatcher therefore catches, writes `status = 'failed'` with the SQLSTATE, and returns `-1`. The
code is stored as `sqlstate_22023` rather than `22023` because 0007 constrains `error_type` to start with
a letter — writing the bare code makes the failure record itself fail, which testing caught. One failing
job never stops the rest of the schedule.

Applying the migration twice is a no-op: any `marketplace.*` job the contract no longer names is
unscheduled first, and `cron.schedule()` upserts on the job name. `public.cron_job_problems()` compares
the real catalogue with the contract in both directions — missing, misscheduled, repointed, deactivated,
or scheduled without being contracted — and is folded into the 0031 umbrella, so the deploy-time
assertion and the nightly job now cover the schedule too.

Following the pg_cron privilege finding in 0031, the same audit was repeated across the rest of the
extension and found three more `PUBLIC` grants: `select` on `cron.job`, `select, delete` on
`cron.job_run_details`, and `execute` on `cron.schedule()`, `cron.unschedule()` and
`cron.job_cache_invalidate()`. No request role could reach them, having no `usage` on the `cron` schema,
but all are revoked here. Each revoke was verified against a live schedule → execute → unschedule cycle:
the background worker still runs jobs and still records them.

### The security contract

0031 adds nothing to the domain and removes nothing from it. It writes the security model down as data
and as functions, and then asserts it: the last statement of the migration calls
`app_private.assert_security_contract()`, so a deployment that would leave the database in a state the
contract forbids fails there rather than in production. `public.security_contract_problems()` returns one
row per violation and nothing when the model holds; the pgTAP suite, CI and the admin security page all
read that one source of truth instead of each re-deriving the rules.

What it asserts: row level security on every table in `public`, `app_private` and `audit`; no grant that
no policy governs, and no write grant that no policy could ever satisfy; no policy naming `anon`; `anon`
holding no table, column, routine, sequence or schema privilege anywhere; `authenticated` holding nothing
in `app_private` and nothing outside the application schemas but `select` on `realtime.messages`;
`app_system` and `app_worker` holding no table or column privilege at all; `app_api` holding nothing of
its own; no application function executable by `PUBLIC`; every `SECURITY DEFINER` function pinning
exactly `search_path = pg_catalog, public`; every view setting `security_invoker`; and the storage
contract from 0012.

`app_private.append_only_contract` names the thirty tables that must refuse `UPDATE` and `DELETE` — the
ledger, the audit log, every status and slug history, every event stream — together with the only
column-level exception in the schema, a notification's own `read_at` and `archived_at`. The guard checks
both directions, so a table that rejects writes but is missing from the contract is itself a violation
and the contract cannot quietly fall behind the schema.

The audit behind the migration found one privilege that no migration granted: the pg_cron extension
grants `select` on its own two sequences to `PUBLIC`, which every role inherits. `anon` could not reach
them, having no `usage` on the `cron` schema, but the grant is revoked here all the same.

Two things 0031 deliberately does not do. It does not set `force row level security`: every
`SECURITY DEFINER` writer in 0001 to 0030 is owned by the table owner and is meant to write rows no
policy permits, which is the whole shape of the model. And it does not use
`alter default privileges ... revoke execute on functions from public` — that was written, applied and
measured, and PostgreSQL records nothing for it, so a function created afterwards still carries
`PUBLIC EXECUTE`. The guard is the mechanism instead: a future migration that forgets its revoke fails
the assertion rather than silently widening the surface.

### CMS and SEO

CMS content is what the marketplace publishes about itself — pages, the blog, FAQs, the homepage
composition, banners and menus — and the specification files the whole module under Admin. Nothing here
is writable by a seller or a buyer, and no CMS row carries a seller's words: seller-authored content
stays in `listings`, in its own writing language, untranslated (D7).

Nothing is duplicated. A menu entry that points at a category stores the category id; a homepage section
that features listings stores their ids in its `config`. Titles, prices and images are read from the
owning table at render time, so a rename can never leave a stale copy behind in the navigation.

Publication is one lifecycle, shared by pages and posts and enforced by `app_private.tg_cms_transition()`
rather than by convention: `draft → scheduled → published → archived`, with each state owning its
timestamp. A row is public only when `public.cms_content_is_public(status, published_at)` says so, and
every public policy is written in terms of that one function — so a draft, a post whose scheduled moment
has not arrived, and an archived page are refused by row level security rather than merely unlinked.
`app_private.publish_due_content()` is the scheduled half, for the pg_cron job 0032 adds. Any change that
alters what a visitor sees publishes an outbox event in the same transaction, which is the revalidation
path C11 already requires; an edit that changes nothing observable publishes nothing.

Localization follows what was already here. Long-form content has a translation table keyed by
`locale_code`, as `category_translations` is; short administrative labels use the `*_en` / `*_ar` pair
that `locales`, `permissions` and `site_settings` use. English is required, Arabic optional, and a locale
with no row is simply untranslated — nothing is generated, copied or derived.

SEO cannot point off the site. `canonical_path`, a banner's `link_path`, a navigation item's `path` and
both sides of a redirect are relative paths, with a CHECK that refuses a scheme or a leading `//`. Robots
directives come from an allowlist and may not contradict each other. `seo_metadata` is publication-aware:
`public.seo_metadata_is_public()` asks the owning table whether the thing described is visible yet, so
metadata about a draft page is staff-only and a draft's title cannot leak through the SEO surface.
`public.resolve_redirect()` follows the map at most five hops and stops on a cycle.

Search stays on the existing foundation: translations carry a generated `search_vector` built with the
same `english` and `arabic` configurations 0011 uses for listings, indexed with GIN. No second search or
cache system is introduced.

CMS images live in a **private** `cms-media` bucket and are served by API-issued signed URL (C15),
because the approved storage architecture reserves the one public bucket for approved listing variants.
The bucket is registered in 0012's contract table, so `storage_bucket_problems()` still returns nothing
and 0012's own assertions — one public bucket, one `storage.objects` policy — remain true as written.

### Notifications

A notification is *what happened to a user*. Whether and how that reached them is delivery state, and
lives where it already lived: `email_outbox` from 0008 for email, and the per-user Realtime topic from
0014 for in-app. The two are linked by `notifications.email_outbox_id` rather than merged, so a row
that was never emailed and a row whose email bounced are still two different things.

Nothing announces itself. `app_private.create_notification()` writes the row and calls
`enqueue_outbox_event('notification', …, 'notification.created', …)` in the same transaction, so a
notification is published exactly when the work that caused it commits — the existing transactional
publication guarantee, not a second one. The event payload carries the notification id, the topic
(`public.notification_topic(user_id)`, which is 0014's `user:<id>` — there is no second Realtime
system) and the minimum display fields; it deliberately does not carry `variables`, so the reader
fetches the row under its own RLS rather than receiving a copy of anything (UB7's reference rule).

Forging is structurally impossible rather than policed. No role holds `INSERT` on `public.notifications`
— only the two `SECURITY DEFINER` writers do, and they are executable by `app_system` and `app_worker`
alone. `authenticated` holds `SELECT` plus a column-level `UPDATE (read_at, archived_at)`, so a user can
mark their own notifications read or archived and can change nothing else; `origin`, `actor_user_id`,
`event_type` and the rest are frozen by `app_private.tg_notifications_immutable()`, deletion is refused,
and `anon` holds nothing. `origin = 'staff'` must name its actor and `origin = 'system'` must not.

What a user gets is decided by the `user_settings` flags that already exist (`notify_in_app`,
`notify_email`, `marketing_opt_in`); no new preference surface was introduced. WhatsApp stays OTP-only
(C21). UB6's approved rule is untouched, and its open notification mechanism stays open.

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

### Storage, Realtime and money rules

Buckets are defined only in migration 0012 and their privacy is a contract that
`storage_bucket_problems()` checks: `listing-variants` is the one public bucket, everything else is
private, and `storage.objects` carries exactly one policy — for that public bucket. Private objects are
reached only through short-lived API-signed URLs (C15).

Realtime uses private topics only. `conversation:<id>:v<membership_version>`, `user:<user_id>` and (from
0028) `ticket:<id>` are the only joinable shapes; `can_join_realtime_topic()` fails closed on anything
else. Every membership change increments the conversation's version and writes an outbox event in the
same transaction (UB6), so the previous topic stops receiving messages. `realtime.messages` has no
insert policy: clients receive, the worker publishes with server credentials (N3).

Money keeps its shape everywhere: integer minor units with a `currency_code` per record, percentages in
basis points, and composite `(id, currency_code)` foreign keys so a shipping zone, a shipping rate, an
offer or a service quote can never disagree with its parent's currency. Every money table registers
itself as a D16 currency blocker. D27 is `resolve_commission_components()`: a fixed component with no
amount for the checkout currency comes back skipped while the others still apply, and
`record_commission_skip()` writes the diagnostic entry.

### Checkout and fulfilment

One cart holds items from several sellers and becomes ONE checkout and ONE payment; `fulfil_checkout()`
then creates one order per seller, their items and the stock decrements, consumes the reservations and
writes the outbox events in a single transaction. It takes a row lock on the checkout and sets
`fulfilled_attempt_id` exactly once: the same attempt retrying is a no-op, a different attempt is
refused, and `orders` carries a unique key on `(checkout_id, seller_user_id)` as a second line of
defence. A trigger makes the fulfilling attempt immutable afterwards. Migration 0021 replaces the
function with one that also posts the ledger journal.

Checkout pricing is snapshotted, never recomputed: the commission rule, fee policy, cancellation policy
and commission-refund policy are stored on the checkout, the listing title and slug on each line, the tax
rate on each tax line, and the cancellation policy again on each order. Totals are enforced by CHECK
constraints (`grand_total = subtotal + shipping + tax + fees - discount`, line totals likewise), a
discount is always stored as a negative amount with its funding source (D11), and shipping is always
attributed to a seller. Stock is held for 15 minutes by `reserve_checkout_stock()`, which locks rows in
listing order so concurrent checkouts queue instead of deadlocking; expired holds stop counting towards
availability and are swept by `release_expired_reservations()`.

References follow D12: `CO-YY-000001` for checkouts and `MP-YY-001001` for seller orders, both from
per-prefix, per-year counters in `app_private.reference_sequences`, generated inside the insert and
immutable afterwards. Delivered service orders auto-complete after the configured buyer-response window
(D23) through `complete_due_service_orders()`.

### Payments

Everything is provider-neutral: `payment_providers` starts empty, no candidate gateway is seeded or
assumed, and `payment_provider_supports()` answers false for any provider, currency or capability that
has not been recorded from the provider's own documentation (`evidence_url` says where). A refund is
refused outright when the provider has no refund capability for that currency, and a partial refund when
it has no partial-refund capability.

`settle_payment_attempt()` is the only path to a `succeeded` attempt — a return URL can never move one.
It refuses on a currency or amount mismatch, never lets a success that arrived after expiry fulfil
directly (D18), and never lets a second success fulfil a checkout another attempt already fulfilled
(D19); each of those opens the matching exception case instead, under the configured policy. Repeating a
settlement is a no-op (C10). Webhook receipts are stored in `payment_events`, unique on
(provider, event key) — that key is the replay protection (C19) — and only a digest of the body is kept.

No refund is ever automatic: a `payment_exception_policies` row whose resolution is a refund or a
reversal must require manual approval, and the CHECK constraint enforces it (D19). Fee allocation
defaults to the platform absorbing provider fees (D20); a split fee is several
`payment_fee_allocations` rows sharing an `allocation_group_id`, one per party, so platform, seller,
buyer and split are all expressible without a later schema change.

### Ledger, balances and withdrawals

The ledger is double-entry and single-currency. Every journal's debits equal its credits, every amount
is a positive integer in minor units with the direction carrying the sign, and every journal names one
currency. Nothing in the ledger is ever updated or deleted: `ledger_journals`, `ledger_entries` and
`commissions` all carry the append-only trigger, and a mistake is corrected by
`reverse_ledger_journal()`, which posts the mirror image and is itself limited to one reversal per
journal. Posting happens only through `app_private.post_ledger_journal()` — no role holds INSERT on any
ledger table — and that function refuses an unbalanced, single-sided or zero journal before it writes
anything. A deferred constraint trigger on `ledger_entries` is the structural backstop, so even a
direct write cannot reach commit with a journal that does not balance.

The chart of accounts holds the fifteen account types the specification lists. Platform accounts are one
row per (type, currency); seller accounts are one row per (type, currency, seller). Accounts are created
on demand, and `normal_balance` is generated from the account type so it can never disagree with it.

`seller_balances` is keyed by `(seller_user_id, currency_code)` and holds `pending`, `available` and
`reserved`. It is a cache of the ledger, maintained only by the posting function, which locks the row
and applies each journal's per-seller delta in seller order so concurrent journals queue rather than
deadlock. The three non-negative CHECK constraints are what makes an overdraw impossible: a journal that
would spend money a seller does not have fails on the constraint, not on a read-then-write race.
`wallet_transactions` is the seller-facing statement over those entries — a `security_invoker` view, so
the row level security on `ledger_entries` is what decides who sees what.

Fulfilment posts the capture journal in the same transaction that creates the orders: the captured
amount is debited to `provider_clearing`, any fee the platform has already agreed to absorb is debited
to `payment_fees` (D20), and each seller's net, the commission, the tax and any buyer fee are credited to
`seller_pending`, `commission_revenue`, `tax` and `buyer_fee_recovery`. If the checkout's own totals and
its lines disagree, fulfilment fails loudly rather than posting a journal against a figure nobody agreed
to. Commission is resolved in NestJS when the checkout is priced and now travels on `checkout_items`
(`commission_minor`, `commission_base_minor`, `commission_snapshot`, added here as a C17 expand); at
fulfilment it is copied onto the order item and snapshotted into `commissions`, including the commission
base D11 depends on and any component D27 skipped.

Earnings land in `pending`. `release_seller_holds()` moves a completed order's earnings to `available`
once the configurable post-completion hold (`finance.seller_hold_days`, default 7) has elapsed, skipping
anything behind an open dispute (D26); 0032 schedules it. The journal's idempotency key is what keeps a
second run from releasing the same order twice. `spend_wallet_on_promotion()` moves money from
`seller_available` to `promotion_revenue` under a row lock and only when available funds cover the price
in full.

A withdrawal follows the approved state machine — `requested → under_review → approved → processing →
paid`, with `cancelled`, `rejected` and `failed` releasing the funds — and a trigger refuses any edge
that is not on it. A CHECK constraint keeps `processing` and `paid` out of reach without an approval, so
there is no payout without an approved withdrawal. Requests fail closed: a currency with no active
`withdrawal_limits` row cannot be withdrawn in at all, the minimum, maximum, open-request and daily
limits are all checked, and an open dispute on any of the seller's orders blocks the request outright
(D26).

> **Spec note for the owner.** The approved state diagram labels `requested → under_review` with "funds
> reserved" but also labels `requested → cancelled` with "funds released". Funds are therefore reserved
> when the request is created, which is the only reading under which both labels hold and the only one
> that stops two requests being raised against the same available balance.

Nothing here assumes the platform holds funds (UB8). The ledger records obligations and the withdrawal
state machine records decisions; a withdrawal's `paid` journal debits `seller_reserved` and credits
`payout_clearing`, leaving the obligation in transit for the payout work in 0022 (blocked by B1-B) and
the settlement reconciliation in 0023 (B1-C).

### Payouts

Payout providers live in their own tables, separate from payment providers even where one company offers
both. `payout_providers` is empty and no adapter exists: nothing is seeded before B1-B closes, and every
capability lookup fails closed, so an unrecorded provider, currency or capability answers false.

The specification's eligibility rule is a CHECK constraint rather than a convention: a provider may only
claim `supports_payout` if it also supports an idempotent payout reference or a reliable status lookup by
our reference, and it must name at least one destination kind it accepts. That is what makes a worker
retry unable to pay twice (C10); `payouts.idempotency_key` is our reference and is unique per provider.

A `payout_destinations` row never holds readable details. It carries a `masked_value` for display and
exactly one of a Vault secret id or a provider token — the CHECK enforces "exactly one", so there is no
shape in which a bank number could sit in an ordinary column. Adding or changing one needs a step-up
grant and aal2, enforced in the RLS policy; the change is audited with the provider token redacted and
publishes an outbox event so the seller is told. The 72-hour hold after an account recovery arrives with
0028.

The payout continues the withdrawal state machine: `create_payout()` accepts only an approved withdrawal
(`payouts.withdrawal_id` is unique, so there is one payout per withdrawal and none at all without one),
checks the provider's eligibility, checks the destination belongs to that seller in that currency for
that provider and is active and verified, honours the D26 dispute freeze, and moves the withdrawal to
`processing` — no money moves, the reservation simply stays put. `settle_payout()` then moves the
withdrawal to `paid` or `failed` through `transition_withdrawal()`, so the ledger journal and the
withdrawal status can never disagree, and repeating an outcome is a no-op while a settled payout can
never be settled differently (C10). Payout webhooks are stored in `payout_events`, unique on
(provider, event key) as the replay protection (C19), digest only.

A payout that comes back is a `payout_reversals` row. Settling it posts the mirror of the payout journal
— payout clearing debited, the seller's available balance credited — and marks the payout `reversed`;
the payout is never rewritten. A reversal is refused unless the payout is paid, the amount is within it,
and the provider records that it supports reversals.

### Provider settlements

A settlement is one statement, from one provider, for one period, in one currency. Payment and payout
providers stay separate abstractions: a statement names exactly one of them and its `settlement_kind`
says which, and the composite key `(id, settlement_kind)` makes a payout line on a payment statement
impossible in the same way `(id, currency_code)` makes a line disagree with its statement's currency
impossible. Statements arrive as data through `open_settlement()` and `record_settlement_item()`; only a
digest of the source file is kept, and re-importing the same reference returns the settlement already
there (C10).

What the provider said is immutable. A statement line can never be deleted, and its kind, direction,
amount, fee, reference and time can never be edited; only our own verdict on it moves, and only forwards
— a matched line can never be unmatched. The evidence is fixed; our reading of it is what changes.

Reconciliation asks two questions. First, does the statement add up: `computed_net_minor` is summed from
the lines and `variance_minor` is what the header claims minus that, so a statement that disagrees with
itself is caught before the ledger is touched. Second, do the lines match our records: each is matched by
provider reference, amount and currency against `payment_provider_transactions` or `payout_transactions`,
and what stays unmatched is money we cannot attribute — which is what `unallocated_receipts` is for.
`clearing_account_balance()` reads the other half of the comparison straight from the ledger.

The journal uses only accounts from the approved chart: `payout_clearing` debited for the payouts the
statement confirms have left, discharging the obligation 0021 and 0022 left in transit; `payment_fees`
for fees the statement reports that were not already recorded (so D20's allocations are never
double-counted); `unallocated_receipts` for what we cannot attribute; `fee_variance` for the statement's
disagreement with itself; and `provider_clearing` taking the balancing side. Nothing posits a bank
balance the platform holds (UB8), and when there is nothing to say, no journal is posted at all.

> **Fail-closed on B1-C.** The settlement model is still open, so posting ships disabled:
> `finance.settlement_posting_enabled` is `false`, and `reconcile_settlement()` answers
> `posting_blocked`, records why, and leaves the settlement at `matched`. Matching, variance detection
> and reporting all run meanwhile, so the reconciliation evidence accumulates without anyone having
> decided the money flow. 0021's journal-type list gains `settlement` here as an ordinary expand step.

### Coupons

A coupon is platform-funded or seller-funded, and the funding source is stored on every record it
touches, because D11 turns on it: a seller-funded discount reduces the commission base, a platform-funded
one does not. A seller-funded coupon can only ever discount its funder's own lines — that restriction
lives in the query that computes the discount, not in the caller. Scope is `all`, a category, a listing
or a listing type, and a category scope reaches the whole branch beneath it through
`category_is_within()` (D8).

Amounts are per currency, in the shape 0016 uses for commission components: a fixed coupon with no
amount configured for the checkout's currency is simply not applicable rather than converted at a rate
nobody approved (D16), while a percentage coupon works anywhere and takes its minimum and cap per
currency. The discount is computed once on the eligible subtotal, in integer minor units, rounded
half-up (D14), then capped by the configured maximum and by the eligible amount itself.

`coupon_check()` answers whether a code applies and what it would be worth without applying it, and
every refusal names its reason — `unknown_code`, `inactive`, `outside_window`,
`redemption_limit_reached`, `user_limit_reached`, `currency_not_configured`, `below_minimum_order`,
`no_eligible_items` — so the storefront can say why instead of only that it failed. Codes match without
regard to case.

`apply_coupon()` moves the discount charge, the redemption record and the checkout totals in one
transaction, under a row lock on the coupon so its last redemption goes to exactly one buyer, and only
while the checkout is still open. Applying the same coupon to the same checkout again returns the
discount already given rather than discounting twice (C10). The discount lands in `checkout_charges` as
a negative row carrying `funding_source`, `source_type = 'coupon'` and the coupon id — the shape 0017
already defined.

`coupon_usage` is append-only. A redemption is given back by appending a reversing row, never by
deleting or editing the original, and `coupons.redemption_count` follows those rows by trigger.
`release_coupon_usage()` is what an abandoned checkout calls.

### Promotions

Packages are admin-defined, with prices per currency, placements and category eligibility in their own
tables. A package with no price in the seller's currency cannot be bought in it (D16); a package with no
category rows is eligible everywhere, and with rows a listing qualifies if its category sits in one of
those branches (D8). `billing_model` is `fixed`: the column admits `pay_on_sale` because the
specification reserves the name, and a second constraint pins it to `fixed` so the reservation is
visible and unusable at once. There is no pay-per-impression or pay-per-click.

The lifecycle is a trigger-enforced state machine — `draft → pending_payment → paid → scheduled →
active → expired`, with `paused` in and out of `active`, and `cancelled`/`refunded` from any live state
— and every edge it takes is written to `promotion_status_history`, which is append-only. Only Approved
or Active listings are eligible, the listing must belong to the seller promoting it, and a partial
unique index allows one live promotion per listing, so the boost does not stack.

Paying from the wallet goes through 0021's `spend_wallet_on_promotion()`: available funds only, in full,
under a row lock, moving the price from `seller_available` to `promotion_revenue`. The listing is
re-checked for eligibility at the moment the money moves, not only when it was chosen, and the promotion
is scheduled in the same transaction. The card path waits for B1-A — a promotion whose payment method is
`card` cannot reach `paid` here at all.

`cancel_promotion()` applies the configured refund policy, prorating when it says to, and that same
policy is what a promoted listing going unavailable falls back on. With nothing configured nothing is
refunded, which is the fail-closed answer. A refund posts the mirror journal — `promotion_revenue`
debited, the seller's available balance credited — so the money story stays double-entry and the
promotion is marked refunded rather than rewritten.

`promotion_events` is the at-least-once sponsored-placement stream: monthly-partitioned, append-only and
deduplicated by event id exactly like `listing_events`, carrying identifiers and a hashed session only.
`promotion_analytics` is the daily rollup the pg_cron job writes (0032 schedules it), recomputable from
source and never the authority for anything. Ranking weights live in `promotion_ranking_settings` for
the search function to read; the formula itself is a Phase 9 decision, so this migration stores weights
and decides nothing.

### Reviews

D13 is done with keys, not with checks in code. `reviews.order_id` is unique, so a duplicate is
impossible at database level, and two composite foreign keys — to `orders (id, buyer_user_id)` and
`orders (id, seller_user_id)` — mean a review cannot name a buyer who did not place the order or a
seller who did not sell it. Those two unique keys are added to `orders` here as indexes only; 0018's
behaviour is unchanged. Eligibility is the half a CHECK cannot express, so a trigger requires the order
to have reached `completed`.

Existence and publication are separate. A review is a durable record of what a buyer said; whether it is
shown is a status that refunds, chargebacks and moderation may all move.
`review_publication_block()` names the current reason — `order_refunded` or `payment_disputed` — and
`reassess_review_publication()` hides the review without destroying it and puts it back when the reason
goes away. A moderator decision is recorded on the row with who made it and why, and from then on the
automatic reassessment leaves that review alone: a moderator's `removed` stays removed. Nobody may
moderate a review they are a party to, and a decision without a reason is refused.

A seller may reply once to a review about them — a trigger refuses anyone else — and the reply carries
its own publication status, so it can be moderated without touching the review it answers.

`seller_ratings` is a view over published reviews only, with the average in basis points, so the
aggregate can never drift from the rows it summarises and the Reviews module still owns exactly the two
tables the specification gives it.

> **One genuine dependency fixed.** 0018 tied `orders.completed_at` to the status both ways, so a
> completed order could never move on to `refunded` without erasing the moment it completed — and a
> review exists precisely because an order completed. The constraint is replaced here with the one-way
> form 0019 already uses for a late payment success: reaching `completed` still stamps the time, and the
> time stays on the record afterwards.

### Reports, moderation and disputes

Three things that look similar are kept apart. A **report** is what a user says about content or about
somebody — a request for a look, never a decision, and the only one of the three a buyer or seller
creates directly. A **moderation action** is what a moderator decided: append-only, always with its
reason and its moderator, corrected by a reinstatement that points at it rather than by an edit. A
**dispute** is between the buyer and the seller of one order, about that order.

Reports and moderation actions name their subject polymorphically, because a report may be about a
listing, a review, a message or a person; the allowed `subject_type` list is the constraint and there is
deliberately no foreign key on `subject_id`, so a report survives its subject being removed — which is
when it matters most. `listing_moderation_actions` is the listing-shaped twin with a real key and the
status move recorded, because a listing's status is what moderation actually changes.
`moderate_listing()` moves the status and writes both trails in one transaction, and 0011's own status
trigger still records the move and withdraws the public variants.

A dispute is **not** a chargeback: `payment_disputes` in 0019 is what a provider raises, and D26's funds
freeze hangs off that one. A dispute here hangs off the seller order by the same composite keys a review
uses, so it cannot name the wrong buyer or the wrong seller, and a partial unique index allows one open
dispute per order. Opening one moves the order to `disputed` and snapshots the status it came from, so
resolving it puts the order back rather than guessing. Funds follow without anything new: 0021's
`release_seller_holds()` only releases `completed` orders, so a disputed order's earnings stay in
`pending` for exactly as long as the dispute is open. Nothing here posts to the ledger — a resolution
decides, and any money it implies moves through the Refunds module with its own record and its own
capability checks.

The thread is append-only: a staff note may be internal, a party's message never is, and the author's
role is worked out from the dispute rather than trusted from an argument. Evidence rows carry only a
reference into the private `dispute-evidence` bucket, and a CHECK refuses a path anywhere else.

Nobody rules on a case they are party to — not their own report, not a listing they sell, not a dispute
they opened — and every decision carries its reason. Both are refusals at the database level.

### Support and account recovery

Two workflows kept deliberately apart. **Support** is for a signed-in user: tickets require login, carry
a D12 reference (`SP-YY-000001`), subject, category, priority, status, messages, attachments, the related
order, the assigned agent, internal notes in their own table and a full event history. An agent reads
what is assigned to them or still queued, at `aal2`. **Account recovery** is for someone who cannot sign
in at all — the specification says locked-out users use recovery and not tickets — so it has its own
tables, its own two-person rule and no read path for the requester beyond a neutral status.

A ticket's Realtime topic carries a membership version exactly as a conversation does: reassigning a
ticket bumps the version, retires the old topic and publishes the membership event in the same
transaction (UB6), and payloads stay event references only (UB7). `can_join_realtime_topic()` is
replaced here with its two existing branches plus support tickets — 0014's own comment said 0028 would
extend it. `support_internal_notes` is a separate table rather than a flag, which is what makes "the
requester can never read this" a table-level fact.

Recovery builds no second authentication system. The one-time code is an `app_private.otp_challenges`
row with `purpose = 'recovery'` — the purpose 0004 already allows — and a contact can only be marked
verified by naming a *consumed* challenge of that purpose whose destination digest matches. The claimed
and new contacts are stored only as digests, so the table cannot leak an address, and `user_id` is NULL
when nothing matched: a request exists either way and looks identical from outside.
`recovery_request_status()` is deliberately lossy — `in_progress`, `completed` or `closed`, never whether
an account matched or why a request ended. The approver table is enforced, not documented: the reviewer
and the approver are always two different people, neither may be the account, and a rejection always
carries its reason. Completion writes the account's own `security_events` row and starts the hold.

> **The 72-hour block, enforced where the specification puts it.** `user_has_security_hold()` is the one
> definition, and it answers false for any operation other than `withdrawal` and `payout_details`.
> `request_withdrawal()` is replaced here with the identical 0021 function plus the hold check — the same
> replace-in-a-later-migration step 0021 used on 0018's `fulfil_checkout()` — and `payout_destinations`
> gains RESTRICTIVE insert and update policies, which AND with 0022's permissive ones so a held seller
> can still read their details but cannot move them, with 0022 untouched. O-1 stays deferred: there are
> no MFA backup codes here; `mfa_reset_at` records only that a reset happened.

### Not built yet, on purpose

`mfa_backup_codes` is conditional on O-1 and its behaviour (D9) is blocked by the AUTH-4/AUTH-5 spikes,
so it is not created. The access-token hook exists but is not enabled in `supabase/config.toml`: wiring
it in belongs to Phase 3, with owner Decision 1 and AUTH-10. Image variant sizes and formats are a
Phase 4 proposal, so `media_variants.variant_key` is free text rather than a fixed set. `payment_method_capabilities` is conditional on D18 and `fee_schedules` and
`fee_allocation_policies` on D20, so none of the three is created. `seller_receivables` and
`receivable_recoveries` are conditional on D21, so negative balances and post-payout recovery have no
schema yet; the `seller_receivable` account type is in the chart of accounts because the specification
lists it, but nothing posts to it. `post_payout_refund_policies` is conditional on D21 as well, so
recovering a refund from an already-paid seller has no schema yet. Support-ticket
Realtime topics are added by 0028, which extends `can_join_realtime_topic()`; ticket payloads stay
event references only (UB7) and topic versioning there is open until Phase 5. The promoted-result
ranking formula and slot merge are Phase 9 decisions.

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

Workflows (`.github/workflows/`), all on `ubuntu-24.04`, with `permissions: {}` at the top and `contents: read` per job, no GitHub Environments, no `pull_request_target` or `workflow_run`, `persist-credentials: false`, a timeout on every job and no automatic test retries. Every job starts with `actions/setup-node` for Node.js 24.21.0 and then checks that `node --version` prints `v24.21.0` (I2). pnpm comes from `pnpm/action-setup` (the `packageManager` field) and is checked to be 12.4.2. All actions are pinned to full commit SHAs (`toolchain/github-actions.json`): actions/checkout v7.0.1, actions/setup-node v7.0.0, pnpm/action-setup v6.1.0, actions/cache v6.1.0 (restore/save), actions/upload-artifact v7.0.1. The only GitHub Actions secret any workflow may reference is the one registered in `policy/ci-secrets.json` (see "B10-hosted"); every other `secrets.` reference fails the check. `pnpm run check:policy` enforces all of this.

- `ci.yml` (pull requests to main, pushes to main, manual):
  - `policy`: frozen install with the dependency files hashed before and after, workspace integrity, workflow policy, install-script policy, 14-day package age (pnpm-managed packages only), `check:env`, currency literals.
  - `security`: gitleaks 8.30.1 over the full git history and the working tree (redacted), osv-scanner 2.6.0 over `pnpm-lock.yaml`. Both tools are downloaded from their GitHub releases and checked against `toolchain/security-tools.json`.
  - `lint-typecheck`: ESLint and strict type checking.
  - `build-test`: redis-server from Ubuntu 24.04 apt (must report 7.0.15; the tests start and stop their own servers, so no service container), uncached build, dependency boundaries (TOOL-6), generated-file drift (TOOL-2), client-bundle environment check, all tests (unit, Supertest API, Redis-down, TOOL-5), tooling tests, TOOL-4 negative control, unchanged dependency files and tracked files.
  - `tool1` (web and admin): TOOL-1 with the pinned Deno and the deny-all proxy, on every pull request.
  - `supabase-local`: starts the local stack with the approved images and exclusions, then TOOL-3, B10-local and TOOL-7 pgTAP, then stops it. It fails until the owner approves the image lock.
  - `e2e`: TOOL-7 Playwright smoke tests (Chromium only) against the built apps.
  - `b10-hosted` (manual only): migrations and verification against the non-production hosted Supabase project (see "B10-hosted").
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

### B10-hosted (non-production Supabase)

`b10-hosted` applies migrations `0001`–`0037` to the **non-production** Supabase project
`slndmkpyakbaradiyaty` (`eu-central-1`, Central EU/Frankfurt) and verifies the result. It is
**`workflow_dispatch`-only**: a job that can reach a credential does not run on every push. It is
additive — the seven Phase 1 jobs are untouched, and `supabase-local` remains the **B10-local**
evidence path. No production project is involved, and the project holds no real personal data.

**The credential.** `B10_HOSTED_DATABASE_URL` is the IPv4 **session-mode** pooler connection string.
The direct host `db.<ref>.supabase.co` publishes no A record, so a GitHub-hosted runner (IPv4 only)
can reach the project *only* through `aws-0-eu-central-1.pooler.supabase.com:5432`. It is the single
entry in `policy/ci-secrets.json`, permitted in `ci.yml` and in the `b10-hosted` job and nowhere else;
any other `secrets.` reference, and this one in another job or workflow, fails the policy check.

**Expiry is scoped (owner decision, option B).** When the registration expires, the repository-wide
policy check still passes and unrelated jobs are unaffected; only `b10-hosted` is disabled. The job
self-gates on the same register *before* any step that can reach the secret, so an expired
registration stops the run rather than being noticed afterwards. This scoped behaviour exists for this
register alone: `osv-exceptions.json`, `release-age-exceptions.json`, `currency-literal-allowlist.json`
and `dependency-overrides.json` keep their own semantics, where an expired entry fails the job.

**The credential never reaches a command line.** `psql` is given no connection argument: host, port,
user and database travel as ordinary environment variables and the password is written to a 0600
`.pgpass` outside the repository, pointed at by `PGPASSFILE`. `pg_prove` runs in the approved
digest-pinned image with that directory mounted read-only and the container running as the same user,
so the password is never a `docker -e` value that `docker inspect` would show. Failures are reduced to
a category before anything is written or printed, because a libpq error can echo the connection it
tried. The result file carries status, counts and categories only — never a password, a connection
string, raw database output or a dump.

**Before anything is applied**, the runner asserts the target: project ref, host, port and database must
match `policy/b10-hosted-decisions.json` exactly, and it fails closed otherwise. Migration `0001`'s own
baseline assertion then stops a run against anything that is not a Supabase database.

**Migration continuity.** Decision B keeps the Supabase CLI local-only, so the hosted database has no
`supabase_migrations.schema_migrations` ledger and the runner deliberately writes no substitute. What it
proves instead: the committed set is contiguous `0001`–`0037`; each file was applied in numeric order in
a single transaction with `ON_ERROR_STOP`; the run stops at the first failure and every file is listed
with its SHA-256; and the resulting schema matches the committed `packages/db/src/schema.ts`. Its limits,
stated plainly: it proves what that run did, not that nothing else changed the database; it is not
idempotent, because the migrations are not written to be re-applied; and it is not a substitute for the
CLI's migration metadata.

**pgTAP** runs out-of-band on this non-production project only. `pgtap` is enabled on the project by the
owner and is **never** added to a migration. The runner uses the already-approved digest-pinned
`public.ecr.aws/supabase/pg_prove:3.36` without `--verbose`, so only the TAP verdict and counts are
recorded.

**psql** is PostgreSQL client major **16** from the Ubuntu 24.04 archive (`toolchain/ci-system.json`,
asserted by `node scripts/ci/checks.mjs psql-version`). The job applies SQL and runs queries; there is no
`pg_dump` or `pg_restore`, so a 16 client against the hosted 17 server is sufficient and no PGDG package
source is introduced.

**Decisions and what is still unverified.** `policy/b10-hosted-decisions.json` records the owner
decisions behind this path, and separately the runtime facts that only an actual run can establish: the
authenticated connection, whether the pooler role holds `CREATEROLE` (migration `0003` needs it) and the
hosted PostgreSQL server version. **None of these has been verified**, and no local suite can change
that. O-3 (the Supabase plan) remains open for unrelated Phase 3 features.

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
