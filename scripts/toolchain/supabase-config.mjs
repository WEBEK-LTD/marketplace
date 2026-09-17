// Reads the few local-stack values TOOL-3 depends on from supabase/config.toml.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './deno.mjs';

export function sectionValues(toml, section) {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start === -1) return {};
  const values = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = /^([a-z_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match) values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

export function tool3StackSettings(toml = readFileSync(join(REPO_ROOT, 'supabase/config.toml'), 'utf8')) {
  const db = sectionValues(toml, 'db');
  const pooler = sectionValues(toml, 'db.pooler');
  const problems = [];
  if (sectionValues(toml, '').project_id !== undefined) problems.push('unexpected root section');
  if (!/^project_id = "marketplace"$/m.test(toml)) problems.push('project_id must be "marketplace"');
  if (db.major_version !== '17') problems.push('db.major_version must be 17');
  if (pooler.enabled !== 'true') problems.push('db.pooler must be enabled');
  if (pooler.pool_mode !== 'transaction') problems.push('db.pooler.pool_mode must be transaction');
  const dbPort = Number(db.port);
  const poolerPort = Number(pooler.port);
  if (!Number.isInteger(dbPort) || !Number.isInteger(poolerPort)) problems.push('db and pooler ports must be set');
  return { dbPort, poolerPort, problems };
}
