// Install-script policy (owner decisions, Steps 3-5; E25): every installed package with an install
// script or native build file must be listed in pnpm-workspace.yaml allowBuilds with the value false,
// and allowBuilds must not list anything that has no such script. Run after `pnpm install`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyError, REPO_ROOT, workspaceSettings } from './lib.mjs';

const HOOKS = ['preinstall', 'install', 'postinstall'];

export function packagesWithInstallScripts(storeDir) {
  if (!existsSync(storeDir)) throw new PolicyError('node_modules/.pnpm not found: run pnpm install first');
  const found = new Map();
  let manifests = 0;
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const modules = join(storeDir, entry.name, 'node_modules');
    if (!existsSync(modules)) continue;
    const candidates = [];
    for (const child of readdirSync(modules, { withFileTypes: true })) {
      if (child.name.startsWith('@')) {
        for (const scoped of readdirSync(join(modules, child.name), { withFileTypes: true })) candidates.push(`${child.name}/${scoped.name}`);
      } else candidates.push(child.name);
    }
    for (const name of candidates) {
      const dir = join(modules, name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (manifest.name !== name) continue;
      manifests += 1;
      const hooks = HOOKS.filter((hook) => typeof manifest.scripts?.[hook] === 'string');
      if (hooks.length === 0 && existsSync(join(dir, 'binding.gyp'))) hooks.push('binding.gyp');
      if (hooks.length > 0) found.set(name, [...new Set([...(found.get(name) ?? []), ...hooks])]);
    }
  }
  return { manifests, found };
}

export function installScriptProblems(found, allowBuilds) {
  const problems = [];
  for (const [name, hooks] of found) {
    if (!(name in allowBuilds)) problems.push(`${name} has install scripts (${hooks.join(', ')}) but is not listed in allowBuilds`);
    else if (allowBuilds[name] !== false) problems.push(`${name} is allowed to run install scripts; only false is permitted`);
  }
  for (const name of Object.keys(allowBuilds)) {
    if (!found.has(name)) problems.push(`allowBuilds lists ${name}, which has no install scripts`);
    if (allowBuilds[name] !== false) problems.push(`allowBuilds.${name} must be false`);
  }
  return [...new Set(problems)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const workspace = workspaceSettings(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'));
    const { manifests, found } = packagesWithInstallScripts(join(REPO_ROOT, 'node_modules/.pnpm'));
    const problems = installScriptProblems(found, workspace.allowBuilds);
    if (problems.length > 0) {
      console.error(`install-script check failed:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`install-script check passed: ${manifests} package manifests; blocked (false): ${[...found.keys()].sort().join(', ')}.`);
  } catch (error) {
    console.error(`install-script check failed: ${error.message}`);
    process.exit(1);
  }
}
