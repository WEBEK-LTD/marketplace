/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are not allowed.",
      from: {},
      to: { circular: true }
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve.",
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      comment: "Shared packages must never import from applications.",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    },
    {
      name: "contracts-framework-free",
      severity: "error",
      comment: "Contracts must not depend on the API framework or HTTP server.",
      from: { path: "^packages/contracts/" },
      to: { path: "(^|node_modules/)(@nestjs|fastify|@fastify)(/|$)" }
    },
    {
      name: "no-app-to-other-app",
      severity: "error",
      comment: "An application must not import from another application.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" }
    },
    {
      // 0108 replaced a boundary the filesystem used to enforce. While the console was `apps/admin`, the rule
      // above kept the two surfaces from reaching into each other; now that both live in `apps/web`, that rule
      // is silent about them and these two take its place. They are the "component boundaries" half of the
      // owner's isolation requirement, stated as something a build can refuse rather than something a reviewer
      // has to notice.
      //
      // `src/admin/paths.ts` is deliberately NOT exempt in either direction: the console imports the mount point
      // from `@repo/config`, and the public surface has no reason to know where the console is mounted.
      //
      // **Exactly two files may cross, and both are singletons Next.js imposes.** `src/app/layout.tsx` is the one
      // root layout an application may have, and `src/i18n/request.ts` is the one next-intl request config — so
      // each has to answer for both surfaces and each branches on the surface header to do it. Nothing else has
      // that excuse. A third entry appearing in this list is the signal that something leaked, which is the whole
      // reason the list is written out rather than expressed as a prefix.
      name: "no-public-surface-into-console",
      severity: "error",
      comment: "The public marketplace surface must not import the admin console's code (0108).",
      from: {
        path: "^apps/web/src/",
        pathNot: "^apps/web/src/(admin/|app/admin/|app/layout\\.tsx$|i18n/request\\.ts$)"
      },
      to: { path: "^apps/web/src/(admin/|app/admin/)" }
    },
    {
      // The reverse, and the more important of the two: the console must not render marketplace chrome, read
      // marketplace BFF helpers or mint marketplace session cookies. The scanner tests assert the cookie half by
      // name; this asserts the whole of it by dependency.
      // `src/server/config.ts` is the one exception, and it is one on principle: the environment belongs to the
      // deployment, not to a surface. There is one Netlify site, one process and one set of variables, so there is
      // one reader of them, and `src/admin/server/config.ts` re-exports it rather than reading the environment a
      // second time. Nothing else under `src/server/` may be reached — least of all the marketplace's BFF or its
      // session cookies.
      name: "no-console-into-public-surface",
      severity: "error",
      comment: "The admin console must not import the public marketplace surface's code (0108).",
      from: { path: "^apps/web/src/(admin/|app/admin/)" },
      to: {
        path: "^apps/web/src/(components/|server/|i18n/routing)",
        pathNot: "^apps/web/src/(admin/|server/config\\.ts$)"
      }
    },
    {
      name: "db-server-only",
      severity: "error",
      comment: "The database package is server-only: the web app (both surfaces), ui and contracts must not import it.",
      from: { path: "^(apps/web|packages/(ui|contracts))/" },
      to: { path: "(^packages/db/|(^|/)node_modules/@repo/db/)" }
    },
    {
      name: "server-config-server-only",
      severity: "error",
      comment: "Server configuration is server-only: ui and contracts must not import it, and the web app only from its server runtime code — on either surface.",
      from: { path: "^(apps/web|packages/(ui|contracts))/", pathNot: "^apps/web/(src/server/|src/admin/server/|src/instrumentation\\.ts$|test/)" },
      to: { path: "(^packages/server-config/|(^|/)node_modules/@repo/server-config/)" }
    },
    {
      name: "server-config-framework-free",
      severity: "error",
      comment: "The configuration package must not depend on application frameworks.",
      from: { path: "^packages/server-config/" },
      to: { path: "(^|node_modules/)(@nestjs|fastify|@fastify|next|react|react-dom|kysely|pg|bullmq|ioredis)(/|$)" }
    },
    {
      name: "telemetry-server-only",
      severity: "error",
      comment: "Telemetry is server-only: ui and contracts must not import it, and the web app only from instrumentation.ts, server code (either surface) and tests.",
      from: { path: "^(apps/web|packages/(ui|contracts))/", pathNot: "^apps/web/(src/server/|src/admin/server/|src/instrumentation\\.ts$|test/)" },
      to: { path: "(^packages/telemetry/|(^|/)node_modules/@repo/telemetry/)" }
    },
    {
      name: "telemetry-framework-free",
      severity: "error",
      comment: "The telemetry package must not depend on application frameworks.",
      from: { path: "^packages/telemetry/" },
      to: { path: "(^|node_modules/)(@nestjs|fastify|@fastify|next|react|react-dom|kysely|pg|bullmq|ioredis|pino)(/|$)" }
    },
    {
      name: "opentelemetry-only-via-telemetry",
      severity: "error",
      comment: "OpenTelemetry is used only through @repo/telemetry.",
      from: { pathNot: "^packages/telemetry/" },
      to: { path: "(^|/)node_modules/@opentelemetry/" }
    },
    {
      name: "no-automatic-instrumentation",
      severity: "error",
      comment: "Owner decision O8-2: no automatic instrumentation, SDK bundle, exporter or module hooking.",
      from: {},
      to: { path: "(^|/)node_modules/(@opentelemetry/(auto-instrumentations|instrumentation|sdk-node|exporter-|sdk-metrics)|@fastify/otel|bullmq-otel|require-in-the-middle|import-in-the-middle)" }
    },
    {
      name: "e2e-isolated",
      severity: "error",
      comment: "The Playwright smoke package is test tooling: nothing imports it, and it imports no workspace code.",
      from: { pathNot: "^packages/e2e/" },
      to: { path: "(^packages/e2e/|(^|/)node_modules/@repo/e2e/)" }
    },
    {
      name: "e2e-no-workspace-imports",
      severity: "error",
      comment: "Smoke tests exercise the apps over HTTP only.",
      from: { path: "^packages/e2e/" },
      to: { path: "(^apps/|^packages/(?!e2e/)|(^|/)node_modules/@repo/)" }
    },
    {
      name: "db-driver-server-only",
      severity: "error",
      comment: "Database drivers must not be imported by the web app (both surfaces), ui or contracts.",
      from: { path: "^(apps/web|packages/(ui|contracts))/" },
      to: { path: "(^|node_modules/)(kysely|pg|pg-[a-z-]+)(/|$)" }
    },
    {
      // v5.2: "Domain code never imports an adapter (dependency-cruiser rule)." Phase 8-C installs the
      // rule with the ports, before any adapter exists, so the first adapter is born inside it rather
      // than having it applied afterwards. A provider adapter lives in a directory named `adapters/`;
      // only the module that wires one up may name it, and domain code reaches a provider through the
      // `PAYMENT_PROVIDER` / `PAYOUT_PROVIDER` injection tokens instead.
      name: "provider-adapters-isolated",
      severity: "error",
      comment: "Domain code must not import a provider adapter; it receives one through its injection token.",
      from: { path: "^(apps|packages)/", pathNot: "((^|/)adapters/|\\.module\\.ts$)" },
      to: { path: "(^|/)adapters/" }
    },
    {
      // G11 allows test doubles "never registered in production". They sit behind their own entry point
      // so production code cannot reach them through the package root, and this refuses the direct path
      // too: only a test may name them.
      name: "provider-test-doubles-not-in-production",
      severity: "error",
      comment: "Provider test doubles may only be imported by tests.",
      from: { path: "^(apps|packages)/", pathNot: "((^|/)test/|\\.test\\.tsx?$|^packages/provider-ports/src/testing/)" },
      to: { path: "^packages/provider-ports/(src/testing/|dist/testing/)" }
    },
    {
      name: "provider-ports-standalone",
      severity: "error",
      comment: "The provider ports are the platform's own contract: they depend on no workspace package and no framework.",
      from: { path: "^packages/provider-ports/src/" },
      to: { path: "(^apps/|^packages/(?!provider-ports/)|(^|/)node_modules/(?!typescript))" }
    },
    {
      // The provisional compliance baseline is a temporary layer that must stay trivially removable: a
      // counsel finding replaces a rule inside it, and the whole package can be deleted in one commit.
      // Depending on nothing is what keeps that true, and it also guarantees the layer cannot reach a
      // database writer, so no "dry run" can post a permanent financial journal through it.
      name: "compliance-standalone",
      severity: "error",
      comment: "The provisional compliance layer depends on no workspace package and no framework, so it stays replaceable and cannot reach a financial writer.",
      from: { path: "^packages/compliance/src/" },
      to: { path: "(^apps/|^packages/(?!compliance/)|(^|/)node_modules/(?!typescript))" }
    }
  ],
  options: {
    // Build output and installed packages are recorded as dependency targets (so rules apply to
    // imports by package name, which resolve into dist/) but are not cruised further.
    doNotFollow: { path: "(^|/)(node_modules|dist)/" },
    exclude: { path: "(^|/)((\\.turbo|\\.next|\\.netlify)/|next-env\\.d\\.ts$)" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".json"]
    }
  }
};
