// Lockfile and workspace integrity (owner decision E25).
//   snapshot <file>  record hashes of the dependency-defining files (store the file outside the repository)
//   verify <file>    fail if any of them changed since the snapshot (for example during install or build)
//   workspace        check the workspace pins and settings
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyError, readJson, REPO_ROOT, sha256, workspaceSettings } from './lib.mjs';

export const EXPECTED = Object.freeze({ node: '24.21.0', pnpm: '12.4.2', minimumReleaseAge: '20160' });
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function workspaceManifests(root = REPO_ROOT) {
  const paths = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, group, entry.name, 'package.json'))) paths.push(`${group}/${entry.name}/package.json`);
    }
  }
  return paths.sort();
}

export function integrityFiles(root = REPO_ROOT) {
  return ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.nvmrc', ...workspaceManifests(root)].sort();
}

export function snapshot(root = REPO_ROOT) {
  return Object.fromEntries(integrityFiles(root).map((path) => [path, sha256(readFileSync(join(root, path)))]));
}

export function changedFiles(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

export function workspaceProblems(root = REPO_ROOT) {
  const problems = [];
  const rootManifest = readJson(join(root, 'package.json'));
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (nvmrc !== EXPECTED.node) problems.push(`.nvmrc must be ${EXPECTED.node}`);
  if (rootManifest.engines?.node !== EXPECTED.node) problems.push(`package.json engines.node must be ${EXPECTED.node}`);
  if (rootManifest.packageManager !== `pnpm@${EXPECTED.pnpm}`) problems.push(`package.json packageManager must be pnpm@${EXPECTED.pnpm}`);
  const ws = workspaceSettings(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  if (JSON.stringify(ws.packages) !== JSON.stringify(['apps/*', 'packages/*'])) problems.push('pnpm-workspace.yaml packages must be apps/* and packages/*');
  if (ws.scalars.minimumReleaseAge !== EXPECTED.minimumReleaseAge) problems.push(`minimumReleaseAge must be ${EXPECTED.minimumReleaseAge}`);
  if (ws.scalars.engineStrict !== 'true') problems.push('engineStrict must be true');
  if (ws.scalars.savePrefix !== '') problems.push('savePrefix must be ""');
  for (const [name, allowed] of Object.entries(ws.allowBuilds)) if (allowed !== false) problems.push(`allowBuilds.${name} must be false`);
  problems.push(...overrideProblems(ws.overrides, root));
  for (const path of workspaceManifests(root)) {
    const manifest = readJson(join(root, path));
    if (path !== 'package.json' && manifest.private !== true) problems.push(`${path} must be private`);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (spec === 'workspace:*' && name.startsWith('@repo/')) continue;
        if (!EXACT.test(spec)) problems.push(`${path} ${section}.${name} must be an exact version (found ${spec})`);
      }
    }
  }
  return problems;
}

/**
 * Security overrides (owner decision, Phase 1 Step 9): every pnpm override must pin an exact version and
 * be documented in policy/dependency-overrides.json with its advisories and the upstream reason, and the
 * register may not contain entries that are not applied. Overrides are temporary security fixes, not
 * dependency upgrades.
 */
export function overrideProblems(overrides, root = REPO_ROOT) {
  const problems = [];
  const register = readJson(join(root, 'policy/dependency-overrides.json'));
  const documented = new Map((register.overrides ?? []).map((entry) => [entry.package, entry]));
  for (const [name, spec] of Object.entries(overrides)) {
    if (!EXACT.test(spec)) problems.push(`overrides.${name} must be an exact version (found ${spec})`);
    const entry = documented.get(name);
    if (!entry) {
      problems.push(`overrides.${name} is not documented in policy/dependency-overrides.json`);
      continue;
    }
    if (entry.version !== spec) problems.push(`policy/dependency-overrides.json records ${name}@${entry.version}, pnpm-workspace.yaml pins ${spec}`);
    if (!Array.isArray(entry.advisories) || entry.advisories.length === 0) problems.push(`policy/dependency-overrides.json ${name} must list the advisories it fixes`);
    if (!entry.reason || !entry.upstream) problems.push(`policy/dependency-overrides.json ${name} must record the reason and the upstream status`);
  }
  for (const name of documented.keys()) {
    if (!(name in overrides)) problems.push(`policy/dependency-overrides.json documents ${name}, which pnpm-workspace.yaml does not override`);
  }
  return problems;
}

function outsideRepository(path) {
  const rel = relative(REPO_ROOT, path);
  return isAbsolute(path) && (rel.startsWith('..') || isAbsolute(rel));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  try {
    if (command === 'snapshot' || command === 'verify') {
      if (!file || !outsideRepository(file)) throw new PolicyError('the snapshot file must be an absolute path outside the repository');
      if (command === 'snapshot') {
        writeFileSync(file, `${JSON.stringify(snapshot(), null, 2)}\n`);
        console.log(`integrity snapshot recorded for ${Object.keys(snapshot()).length} files.`);
      } else {
        const changed = changedFiles(JSON.parse(readFileSync(file, 'utf8')), snapshot());
        if (changed.length > 0) throw new PolicyError(`dependency-defining files changed: ${changed.join(', ')}`);
        console.log('integrity verified: lockfile, workspace file, .nvmrc and package manifests unchanged.');
      }
    } else if (command === 'workspace') {
      const problems = workspaceProblems();
      if (problems.length > 0) throw new PolicyError(problems.join('; '));
      console.log(`workspace integrity passed: Node ${EXPECTED.node}, pnpm ${EXPECTED.pnpm}, minimumReleaseAge ${EXPECTED.minimumReleaseAge}, exact pins in ${workspaceManifests().length} manifests.`);
    } else throw new PolicyError('Usage: node scripts/policy/integrity.mjs <snapshot|verify> <file> | workspace');
  } catch (error) {
    console.error(`integrity check failed: ${error.message}`);
    process.exit(1);
  }
}
