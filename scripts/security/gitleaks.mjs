// Secret scanning (owner decision E16): gitleaks 8.30.1 over the git history and the working tree,
// with redacted output. The summary (written outside the repository) holds rule IDs, files and lines
// only, never secret values. Usage:
//   node scripts/security/gitleaks.mjs --summary <file> [--require-git]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../toolchain/deno.mjs';
import { ensureTool } from '../toolchain/security-tools.mjs';

/** Keeps only non-secret fields of gitleaks findings. */
export function sanitizeFindings(findings) {
  return findings.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine, commit: f.Commit ? String(f.Commit).slice(0, 12) : undefined }));
}

function scan(binary, mode, report) {
  const args = mode === 'git'
    ? ['git', REPO_ROOT, '--redact', '--no-banner', '--config', join(REPO_ROOT, '.gitleaks.toml'), '--report-format', 'json', '--report-path', report, '--exit-code', '3']
    : ['dir', REPO_ROOT, '--redact', '--no-banner', '--config', join(REPO_ROOT, '.gitleaks.toml'), '--report-format', 'json', '--report-path', report, '--exit-code', '3'];
  const run = spawnSync(binary, args, { encoding: 'utf8' });
  if (run.status !== 0 && run.status !== 3) return { error: `gitleaks ${mode} scan did not complete (exit ${run.status})` };
  const findings = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8') || '[]') : [];
  return { findings: sanitizeFindings(findings) };
}

async function main() {
  const summaryPath = process.argv[process.argv.indexOf('--summary') + 1];
  if (!process.argv.includes('--summary') || !summaryPath) throw new Error('Usage: gitleaks.mjs --summary <file> [--require-git]');
  const binary = await ensureTool('gitleaks');
  const work = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  const summary = { tool: 'gitleaks 8.30.1', redacted: true, scans: {} };
  try {
    const hasGit = existsSync(join(REPO_ROOT, '.git'));
    if (hasGit) summary.scans.history = scan(binary, 'git', join(work, 'git.json'));
    else if (process.argv.includes('--require-git')) summary.scans.history = { error: 'git history not available (checkout with full history)' };
    else summary.scans.history = { skipped: 'no .git directory (sandbox or archive checkout)' };
    summary.scans.workingTree = scan(binary, 'dir', join(work, 'dir.json'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const failures = Object.entries(summary.scans).filter(([, s]) => s.error || (s.findings && s.findings.length > 0));
  for (const [name, s] of failures) console.error(`gitleaks ${name}: ${s.error ?? `${s.findings.length} finding(s): ${s.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).join(', ')}`}`);
  if (failures.length > 0) return 1;
  console.log(`gitleaks passed: history ${summary.scans.history.skipped ? `skipped (${summary.scans.history.skipped})` : 'clean'}; working tree clean.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`gitleaks failed: ${error.message}`);
    process.exit(1);
  });
}
