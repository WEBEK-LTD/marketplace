// Dependency vulnerability scanning (owner decision E17): osv-scanner 2.6.0 over pnpm-lock.yaml.
// Every known vulnerability fails unless an unexpired, reviewed exception in policy/osv-exceptions.json
// matches its id, package and version exactly. Usage: node scripts/security/osv.mjs --summary <file>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionProblems, readJson, REPO_ROOT, todayUtc } from '../policy/lib.mjs';
import { ensureTool } from '../toolchain/security-tools.mjs';

const REQUIRED = ['id', 'package', 'version', 'ecosystem', 'justification', 'approvedBy', 'approvedOn', 'expires'];

/** Flattens osv-scanner JSON output to { id, aliases, package, version, ecosystem }. */
export function osvFindings(report) {
  const findings = [];
  for (const result of report.results ?? []) {
    for (const entry of result.packages ?? []) {
      for (const vuln of entry.vulnerabilities ?? []) {
        findings.push({ id: vuln.id, aliases: vuln.aliases ?? [], package: entry.package?.name, version: entry.package?.version, ecosystem: entry.package?.ecosystem });
      }
    }
  }
  return findings;
}

export function evaluateFindings(findings, register, today) {
  const problems = [];
  const valid = [];
  for (const entry of register.exceptions) {
    const issues = exceptionProblems(entry, REQUIRED, today);
    if (issues.length > 0) problems.push(`osv exception ${entry.id ?? '?'} ${entry.package ?? '?'}@${entry.version ?? '?'}: ${issues.join(', ')}`);
    else valid.push(entry);
  }
  const accepted = [];
  for (const f of findings) {
    const ok = valid.find((e) => (e.id === f.id || f.aliases.includes(e.id)) && e.package === f.package && e.version === f.version && e.ecosystem.toLowerCase() === String(f.ecosystem).toLowerCase());
    if (ok) accepted.push(`${f.id} ${f.package}@${f.version}`);
    else problems.push(`vulnerability ${f.id} in ${f.package}@${f.version}`);
  }
  const unused = valid.filter((e) => !findings.some((f) => (e.id === f.id || f.aliases.includes(e.id)) && e.package === f.package && e.version === f.version)).map((e) => `${e.id} ${e.package}@${e.version}`);
  return { problems, accepted, unused };
}

async function main() {
  if (!process.argv.includes('--summary')) throw new Error('Usage: osv.mjs --summary <file>');
  const summaryPath = process.argv[process.argv.indexOf('--summary') + 1];
  const binary = await ensureTool('osv-scanner');
  const work = mkdtempSync(join(tmpdir(), 'osv-'));
  const output = join(work, 'osv.json');
  let summary;
  try {
    const run = spawnSync(binary, ['scan', 'source', '--lockfile', join(REPO_ROOT, 'pnpm-lock.yaml'), '--format', 'json', '--output-file', output], { encoding: 'utf8' });
    // osv-scanner exits 0 (no findings) or 1 (findings); anything else means the scan did not complete.
    if (run.status !== 0 && run.status !== 1) {
      summary = { tool: 'osv-scanner 2.6.0', error: `scan did not complete (exit ${run.status})` };
    } else {
      const findings = osvFindings(JSON.parse(readFileSync(output, 'utf8')));
      const packages = JSON.parse(readFileSync(output, 'utf8')).results?.reduce((n, r) => n + (r.packages?.length ?? 0), 0) ?? 0;
      const result = evaluateFindings(findings, readJson(join(REPO_ROOT, 'policy/osv-exceptions.json')), todayUtc());
      summary = { tool: 'osv-scanner 2.6.0', lockfile: 'pnpm-lock.yaml', vulnerablePackages: packages, findings: findings.map((f) => `${f.id} ${f.package}@${f.version}`), acceptedByException: result.accepted, unusedExceptions: result.unused, problems: result.problems };
      if (run.status === 1 && findings.length === 0) summary.problems.push('osv-scanner reported findings that could not be read');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.error) {
    console.error(`osv-scanner failed: ${summary.error}`);
    return 1;
  }
  if (summary.problems.length > 0) {
    console.error(`osv-scanner failed:\n  ${summary.problems.join('\n  ')}`);
    return 1;
  }
  console.log(`osv-scanner passed: no unexcepted vulnerabilities${summary.acceptedByException.length ? `; accepted by exception: ${summary.acceptedByException.join(', ')}` : ''}${summary.unusedExceptions.length ? `; unused exceptions to remove: ${summary.unusedExceptions.join(', ')}` : ''}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`osv-scanner failed: ${error.message}`);
    process.exit(1);
  });
}
