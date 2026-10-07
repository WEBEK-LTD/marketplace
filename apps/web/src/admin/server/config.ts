import 'server-only';

/**
 * The console's view of the deployment's configuration (0108).
 *
 * The console used to be an application, so it had an environment reader of its own: `readNextServerConfig('admin')`
 * over the two variables it needed. It is a surface now, and **the environment belongs to the deployment rather than
 * to a surface** — there is one Netlify site, one process and one set of variables — so there is one reader, in
 * `src/server/config.ts`, and this module is how the console reaches it.
 *
 * Kept as a module rather than deleted so the console's BFF keeps importing `../config`, which is what it has always
 * imported and what every one of its tests expects. What changed is where the value comes from, not who asks.
 *
 * The web reader returns a superset — it also carries the optional `PUBLIC_WEB_ORIGIN`, which the sitemap and robots
 * documents need and the console has no use for. A superset is not a problem: the console reads the two fields it
 * has always read, and a field it never touches cannot affect it.
 *
 * `validateServerConfigAtStartup` is deliberately **not** re-exported. One runtime validates its configuration once,
 * in `src/instrumentation.ts`, and a second entry point for it would be a second start-up log line claiming a second
 * component that does not exist.
 */
export { loadServerConfig } from '../../server/config';
