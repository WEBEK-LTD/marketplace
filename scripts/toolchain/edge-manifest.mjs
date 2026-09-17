// Evidence for owner decision E1: with edge.netlify.com blocked, the edge bundler cannot extract
// in-source function config and falls back to none. This verifies that nothing was lost:
//  1. every generated edge-function entry exports only a default handler (no `config` to extract);
//  2. the bundler manifest's routes and function config match the Next.js runtime's declarations.
// Anything the verifier does not understand fails closed.

const HANDLED_KEYS = new Set(['function', 'name', 'generator', 'pattern', 'excludedPattern', 'cache', 'onError', 'rateLimit']);
const CONFIG_KEYS = ['name', 'generator', 'onError', 'rateLimit'];

/** Same normalisation as @netlify/edge-bundler 16.0.4 (normalizePattern + serializePattern). */
export function expectedPattern(pattern) {
  let enclosed = pattern;
  if (!enclosed.startsWith('^')) enclosed = `^${enclosed}`;
  if (!enclosed.endsWith('$')) enclosed = `${enclosed}$`;
  return new RegExp(enclosed).toString().slice(1, -1).replace(/\\\//g, '/');
}

/** The entry module may contain exactly one export: `export default`. */
export function checkEntryExports(name, source) {
  const exports = source.match(/^\s*export\b.*$/gm) ?? [];
  if (exports.length !== 1 || !/^\s*export\s+default\b/.test(exports[0])) {
    return [`edge function ${name}: entry must export only a default handler (found ${exports.length} export statements)`];
  }
  return [];
}

function stable(value) {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

export function compareEdgeManifests(runtime, bundled) {
  const problems = [];
  if (runtime?.version !== 1 || !Array.isArray(runtime.functions) || runtime.functions.length === 0) {
    return ['runtime manifest: unsupported format or no functions'];
  }
  const routes = Array.isArray(bundled?.routes) ? bundled.routes : null;
  const postCache = Array.isArray(bundled?.post_cache_routes) ? bundled.post_cache_routes : null;
  const config = bundled?.function_config;
  if (routes === null || postCache === null || config === null || typeof config !== 'object') {
    return ['bundler manifest: unsupported format'];
  }

  const declared = new Set();
  for (const declaration of runtime.functions) {
    const fn = declaration.function;
    const unknown = Object.keys(declaration).filter((key) => !HANDLED_KEYS.has(key));
    if (unknown.length > 0) problems.push(`${fn}: declaration keys not handled by the verifier: ${unknown.join(', ')}`);
    if (typeof declaration.pattern !== 'string') {
      problems.push(`${fn}: only pattern-based declarations are supported by the verifier`);
      continue;
    }
    if (declared.has(fn)) problems.push(`${fn}: declared more than once`);
    declared.add(fn);

    const excluded = declaration.excludedPattern === undefined ? [] : [declaration.excludedPattern].flat();
    const expectedRoute = { function: fn, pattern: expectedPattern(declaration.pattern), excluded_patterns: excluded.map(expectedPattern) };
    const [expectedList, otherList, listName] =
      declaration.cache === 'manual' ? [postCache, routes, 'post_cache_routes'] : [routes, postCache, 'routes'];
    const found = expectedList.filter((route) => route.function === fn);
    if (found.length !== 1 || stable(found[0]) !== stable(expectedRoute)) {
      problems.push(`${fn}: ${listName} entry differs. expected ${stable(expectedRoute)}, got ${stable(found)}`);
    }
    if (otherList.some((route) => route.function === fn)) problems.push(`${fn}: unexpected route in the other route list`);

    const expectedConfig = Object.fromEntries(CONFIG_KEYS.filter((key) => declaration[key] !== undefined).map((key) => [key, declaration[key]]));
    if (stable(config[fn]) !== stable(expectedConfig)) {
      problems.push(`${fn}: function_config differs. expected ${stable(expectedConfig)}, got ${stable(config[fn])}`);
    }
  }
  for (const route of [...routes, ...postCache]) {
    if (!declared.has(route.function)) problems.push(`bundler manifest: route for undeclared function ${route.function}`);
  }
  for (const fn of Object.keys(config)) {
    if (!declared.has(fn)) problems.push(`bundler manifest: config for undeclared function ${fn}`);
  }
  if (!Array.isArray(bundled.bundles) || bundled.bundles.length !== 1 || bundled.bundles[0].format !== 'eszip2') {
    problems.push('bundler manifest: expected exactly one eszip2 bundle');
  }
  return problems;
}
