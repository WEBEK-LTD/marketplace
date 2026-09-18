// Image digest lock for the local Supabase stack (owner decisions S13 and E7).
//   verify            every running container of the project uses an approved image digest (fail closed)
//   verify-transient  approved digests of short-lived images (the pg_prove image used by `supabase test db`)
// Discovery (`scripts/ci/supabase-local.mjs record`) only proposes digests; the owner reviews them and
// commits an approved lock. Nothing is trusted on first use.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './deno.mjs';

export const IMAGES_FILE = join(REPO_ROOT, 'toolchain/supabase-images.json');
export const PROJECT_LABEL = 'com.supabase.cli.project=marketplace';
export const EXCLUDABLE_SERVICES = Object.freeze(['gotrue', 'realtime', 'storage-api', 'imgproxy', 'kong', 'mailpit', 'postgrest', 'postgres-meta', 'studio', 'edge-runtime', 'logflare', 'vector']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class ImageLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageLockError';
  }
}

/**
 * A bounded, sanitised fragment of a tool's stderr, safe for CI logs. Docker is invoked here only with
 * digests, references and container ids (never with credentials), but the registry may still echo text,
 * so credential-shaped values are removed before anything is logged.
 */
export function sanitizeToolError(text, limit = 200) {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';
  const safe = line
    .replace(/[a-z0-9+.-]+:\/\/[^\s]*/gi, '<url>')
    .replace(/\b[\w.-]+:[^\s@/]+@/g, '<credentials>@')
    // Everything after a credential keyword is dropped, not just the next word: a header such as
    // "Authorization: Bearer <jwt>" must not leave any part of the value behind.
    .replace(/\b(authorization|token|password|passwd|secret|api[-_]?key|bearer)\b.*$/i, '$1 <redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

export function readLock(path = IMAGES_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function docker(args) {
  const run = spawnSync('docker', args, { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    const detail = sanitizeToolError(run.error ? (run.error.code ?? run.error.message) : run.stderr);
    throw new ImageLockError(`docker ${args[0]} failed${detail ? `: ${detail}` : ' (is Docker available?)'}`);
  }
  return run.stdout.trim();
}

export function repository(reference) {
  return reference.replace(/^[^/]+\.[^/]+\//, '').replace(/[:@].*$/, '');
}

/** Problems that make a lock unusable. An empty list means the owner approved it completely. */
export function approvalProblems(lock) {
  const problems = [];
  if (lock.status !== 'approved') return ['image digests are not approved yet (toolchain/supabase-images.json): run the supabase-images-record workflow and have the owner approve the proposal'];
  if (typeof lock.approvedBy !== 'string' || lock.approvedBy.trim() === '') problems.push('approvedBy is required');
  if (typeof lock.approvedOn !== 'string' || !DATE.test(lock.approvedOn)) problems.push('approvedOn must be YYYY-MM-DD');
  if (!Array.isArray(lock.images) || lock.images.length === 0) problems.push('no approved images');
  for (const image of lock.images ?? []) {
    if (typeof image.reference !== 'string' || !DIGEST.test(image.digest ?? '')) problems.push(`invalid image entry ${JSON.stringify(image)}`);
  }
  for (const service of lock.excludedServices ?? []) {
    if (!EXCLUDABLE_SERVICES.includes(service)) problems.push(`service ${service} may not be excluded`);
  }
  if ((lock.excludedServices ?? []).length > 0 && !lock.exclusionEvidence) problems.push('excludedServices needs exclusionEvidence');
  if (typeof lock.poolerUserFormat !== 'string' || !lock.poolerUserFormat.includes('{role}')) problems.push('poolerUserFormat (containing {role}) is required');
  if (!lock.poolerUserFormatEvidence) problems.push('poolerUserFormatEvidence is required');
  return problems;
}

/** The running project containers with their image reference and repository digests. */
export function projectImages() {
  const ids = docker(['ps', '--filter', `label=${PROJECT_LABEL}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
  if (ids.length === 0) throw new ImageLockError('No running containers for the local Supabase project "marketplace".');
  return ids.map((id) => {
    const [container] = JSON.parse(docker(['inspect', id]));
    const [image] = JSON.parse(docker(['image', 'inspect', container.Image]));
    return { container: container.Name.replace(/^\//, ''), reference: container.Config.Image, repoDigests: image.RepoDigests ?? [] };
  });
}

/** Local images whose repository matches (for short-lived containers such as pg_prove). */
export function localImages(repositoryPart) {
  const lines = docker(['image', 'ls', '--digests', '--format', '{{.Repository}}:{{.Tag}} {{.Digest}}']).split('\n').filter(Boolean);
  return lines
    .map((line) => {
      const [reference, digest] = line.split(' ');
      return { container: 'transient', reference, repoDigests: digest && digest !== '<none>' ? [`${reference.replace(/:[^:]*$/, '')}@${digest}`] : [] };
    })
    .filter((item) => repository(item.reference).includes(repositoryPart));
}

function digestProblems(lock, items) {
  const problems = [];
  for (const item of items) {
    const approved = lock.images.find((entry) => entry.reference === item.reference);
    if (approved === undefined) problems.push(`${item.container}: image ${item.reference} is not approved`);
    else if (!item.repoDigests.some((digest) => digest.endsWith(`@${approved.digest}`))) problems.push(`${item.container}: digest mismatch for ${item.reference}`);
  }
  return problems;
}

export function verifyImages(lock = readLock(), running = projectImages()) {
  const approval = approvalProblems(lock);
  if (approval.length > 0) return approval;
  const problems = digestProblems(lock, running);
  for (const required of lock.requiredServices) {
    if (!running.some((item) => repository(item.reference) === required)) problems.push(`required service ${required} is not running`);
  }
  return problems;
}

export function verifyTransient(lock = readLock(), images = localImages('pg_prove')) {
  const approval = approvalProblems(lock);
  if (approval.length > 0) return approval;
  if (images.length === 0) return ['no pg_prove image found after pgTAP'];
  return digestProblems(lock, images);
}

/** Name without tag or digest, keeping the registry host (for pulls by digest). */
export function imageName(reference) {
  return reference.replace(/@.*$/, '').replace(/:[^:/]*$/, '');
}

/**
 * Pulls every approved image by its digest and tags it with the reference the CLI uses, so the CLI finds
 * approved content locally before it starts anything. Content addressed: a moved tag upstream cannot
 * change what runs. Verification after start remains the second check.
 */
export function pullApprovedImages(lock = readLock(), { transient = false } = {}) {
  const approval = approvalProblems(lock);
  if (approval.length > 0) throw new ImageLockError(approval.join('; '));
  const images = lock.images.filter((image) => Boolean(image.transient) === transient);
  for (const image of images) {
    const pinned = `${imageName(image.reference)}@${image.digest}`;
    docker(['pull', '--quiet', pinned]);
    docker(['tag', pinned, image.reference]);
  }
  return images.length;
}

/** A proposal from discovered images (never written to the lock by tooling). */
export function proposeImages(items) {
  const byReference = new Map();
  for (const item of items) {
    const digests = [...new Set(item.repoDigests.map((d) => d.split('@')[1]))];
    if (digests.length !== 1) throw new ImageLockError(`${item.reference}: expected exactly one repository digest, found ${digests.length}`);
    byReference.set(item.reference, { reference: item.reference, digest: digests[0], ...(item.container === 'transient' ? { transient: true } : {}) });
  }
  return [...byReference.values()].sort((a, b) => a.reference.localeCompare(b.reference));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const problems = command === 'verify' ? verifyImages() : command === 'verify-transient' ? verifyTransient() : undefined;
    if (problems === undefined) throw new ImageLockError('Usage: node scripts/toolchain/supabase-images.mjs <verify|verify-transient>');
    if (problems.length > 0) throw new ImageLockError(problems.join('; '));
    console.log(`Supabase image digests verified against the approved lock (${command}).`);
  } catch (error) {
    console.error(error instanceof ImageLockError ? error.message : String(error));
    process.exit(1);
  }
}
