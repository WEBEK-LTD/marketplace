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
      name: "db-server-only",
      severity: "error",
      comment: "The database package is server-only: the web and admin apps, ui and contracts must not import it.",
      from: { path: "^(apps/(web|admin)|packages/(ui|contracts))/" },
      to: { path: "(^packages/db/|(^|/)node_modules/@repo/db/)" }
    },
    {
      name: "server-config-server-only",
      severity: "error",
      comment: "Server configuration is server-only: ui and contracts must not import it, and web/admin only from their server runtime code.",
      from: { path: "^(apps/(web|admin)|packages/(ui|contracts))/", pathNot: "^apps/(web|admin)/(src/server/|src/instrumentation\\.ts$|test/)" },
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
      comment: "Telemetry is server-only: ui and contracts must not import it, and web/admin only from instrumentation.ts, server code and tests.",
      from: { path: "^(apps/(web|admin)|packages/(ui|contracts))/", pathNot: "^apps/(web|admin)/(src/server/|src/instrumentation\\.ts$|test/)" },
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
      comment: "Database drivers must not be imported by the web and admin apps, ui or contracts.",
      from: { path: "^(apps/(web|admin)|packages/(ui|contracts))/" },
      to: { path: "(^|node_modules/)(kysely|pg|pg-[a-z-]+)(/|$)" }
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
