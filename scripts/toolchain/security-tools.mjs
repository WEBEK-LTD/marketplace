// Pinned standalone security tools (owner decisions E12, E16, E17). Downloads the official release
// outside the repository, verifies every checksum and the exact version output, and fails closed.
// Usage: node scripts/toolchain/security-tools.mjs <gitleaks|osv-scanner>   (prints the binary path)
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { REPO_ROOT, ToolchainError, toolchainRoot } from './deno.mjs';

export const SECURITY_TOOLS = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchain/security-tools.json'), 'utf8')).tools;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function toolPath(name) {
  const tool = SECURITY_TOOLS[name];
  if (!tool) throw new ToolchainError(`Unknown tool ${name}.`);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new ToolchainError(`No pinned ${name} build for ${process.platform}-${process.arch}.`);
  return join(toolchainRoot(), `${name}-${tool.version}`, tool.binaryName);
}

export function verifyTool(name, binary = toolPath(name)) {
  const tool = SECURITY_TOOLS[name];
  if (!existsSync(binary)) return false;
  if (sha256(readFileSync(binary)) !== tool.binarySha256) throw new ToolchainError(`${name} binary checksum mismatch.`);
  const run = spawnSync(binary, tool.versionArgs, { encoding: 'utf8' });
  const first = `${run.stdout}`.trim().split('\n')[0]?.trim();
  if (run.status !== 0 || first !== tool.versionOutput) throw new ToolchainError(`${name} version check failed.`);
  return true;
}

export async function ensureTool(name) {
  const tool = SECURITY_TOOLS[name];
  const binary = toolPath(name);
  if (verifyTool(name, binary)) return binary;
  const dir = join(toolchainRoot(), `${name}-${tool.version}`);
  if (existsSync(dir)) throw new ToolchainError(`${dir} exists but does not hold the verified ${name}; remove it manually.`);
  mkdirSync(toolchainRoot(), { recursive: true });
  const work = mkdtempSync(join(toolchainRoot(), `.${name}-`));
  try {
    const response = await fetch(tool.url);
    if (!response.ok) throw new ToolchainError(`${name} download failed (HTTP ${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    const staged = join(work, 'stage');
    mkdirSync(staged);
    if (tool.archive === 'tar.gz') {
      if (sha256(data) !== tool.archiveSha256) throw new ToolchainError(`${name} archive checksum mismatch.`);
      writeFileSync(join(work, 'archive.tar.gz'), data);
      const untar = spawnSync('tar', ['-xzf', join(work, 'archive.tar.gz'), '-C', staged, tool.binaryName], { encoding: 'utf8' });
      if (untar.status !== 0) throw new ToolchainError(`${name} archive could not be extracted.`);
    } else {
      writeFileSync(join(staged, tool.binaryName), data);
    }
    chmodSync(join(staged, tool.binaryName), 0o755);
    if (!verifyTool(name, join(staged, tool.binaryName))) throw new ToolchainError(`${name} verification failed.`);
    renameSync(staged, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!verifyTool(name, binary)) throw new ToolchainError(`${name} verification failed after install.`);
  return binary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureTool(process.argv[2]).then(
    (path) => console.log(path),
    (error) => {
      console.error(error instanceof ToolchainError ? error.message : `install failed: ${error.message}`);
      process.exit(1);
    },
  );
}
