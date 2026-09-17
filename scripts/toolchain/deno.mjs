// Pinned Deno toolchain (owner decisions D1-D3). Installs and verifies the exact release outside
// the repository and fails closed on any mismatch. Node built-ins plus the system `unzip`.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DENO_TOOLCHAIN = JSON.parse(readFileSync(join(REPO_ROOT, 'toolchain/deno.json'), 'utf8'));

export class ToolchainError extends Error {}

function platformKey() {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  throw new ToolchainError(`No pinned Deno archive for ${process.platform}-${process.arch}.`);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function toolchainRoot() {
  const root = resolve(process.env.MARKETPLACE_TOOLCHAIN_DIR ?? join(homedir(), '.cache', 'marketplace-toolchain'));
  const rel = relative(REPO_ROOT, root);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) {
    throw new ToolchainError('The toolchain directory must be outside the repository.');
  }
  return root;
}

export function denoInstallDir() {
  return join(toolchainRoot(), 'deno', DENO_TOOLCHAIN.version);
}

/** Checks the installed binary: exact hash and exact `--version` line. Throws on any mismatch. */
export function verifyDeno(binary = join(denoInstallDir(), 'deno')) {
  const pin = DENO_TOOLCHAIN.platforms[platformKey()];
  if (!existsSync(binary)) throw new ToolchainError(`Pinned Deno binary is missing: ${binary}`);
  const actual = sha256(readFileSync(binary));
  if (actual !== pin.binarySha256) throw new ToolchainError(`Deno binary checksum mismatch (${actual}).`);
  const run = spawnSync(binary, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' } });
  if (run.status !== 0) throw new ToolchainError('Pinned Deno binary cannot be executed.');
  const firstLine = run.stdout.split('\n')[0];
  if (firstLine !== pin.versionLine) throw new ToolchainError(`Unexpected Deno version: ${firstLine}`);
  return binary;
}

/** Installs the pinned release if absent. An existing but different installation is an error, never replaced. */
export async function ensureDeno() {
  const pin = DENO_TOOLCHAIN.platforms[platformKey()];
  const dir = denoInstallDir();
  const binary = join(dir, 'deno');
  if (existsSync(dir)) return verifyDeno(binary);

  mkdirSync(dirname(dir), { recursive: true });
  const staging = mkdtempSync(join(dirname(dir), '.staging-'));
  try {
    const url = new URL(pin.archive, DENO_TOOLCHAIN.downloadBase).href;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new ToolchainError(`Deno download failed with status ${res.status}.`);
    const archive = Buffer.from(await res.arrayBuffer());
    const archiveHash = sha256(archive);
    if (archiveHash !== pin.archiveSha256) throw new ToolchainError(`Deno archive checksum mismatch (${archiveHash}).`);
    const archivePath = join(staging, pin.archive);
    writeFileSync(archivePath, archive);
    const unzip = spawnSync('unzip', ['-q', '-o', archivePath, 'deno', '-d', staging], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new ToolchainError('Could not extract the Deno archive (is `unzip` installed?).');
    rmSync(archivePath);
    chmodSync(join(staging, 'deno'), 0o755);
    verifyDeno(join(staging, 'deno'));
    renameSync(staging, dir);
    return verifyDeno(binary);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureDeno().then(
    (binary) => console.log(`Pinned Deno ${DENO_TOOLCHAIN.version} verified at ${binary}`),
    (error) => {
      console.error(error instanceof ToolchainError ? error.message : `Deno toolchain failed: ${error}`);
      process.exit(1);
    },
  );
}
