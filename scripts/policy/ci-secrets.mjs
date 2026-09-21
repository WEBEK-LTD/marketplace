// The CI secret register (owner decision, B10-hosted increment, 2026-09-21).
//
//   node scripts/policy/ci-secrets.mjs assert --name <NAME> --workflow <path> --job <job> [--today YYYY-MM-DD]
//
// `assert` is the self-gate a job runs *before* any step that can reach the secret: it exits 1 with a
// deterministic message when the registration is missing, malformed or expired, so an expired
// registration stops the job rather than being noticed afterwards.
//
// Two classes of outcome, and the distinction is the whole point of this file:
//
//   fatal   — an unregistered secret name, a registered name in the wrong workflow or the wrong job, a
//             malformed register, a malformed entry. These fail the repository-wide policy check.
//   scoped  — a structurally valid registration that has expired. This does NOT fail the repository
//             policy check; it disables only the job the registration names (owner decision: expiry
//             option B). Unrelated jobs, workflows and branches are unaffected.
//
// The scoped class exists only here. The other registers in policy/ are untouched: an expired entry in
// osv-exceptions.json, release-age-exceptions.json, currency-literal-allowlist.json or
// dependency-overrides.json still fails its job, exactly as before.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionProblems, PolicyError, readJson, REPO_ROOT, todayUtc } from './lib.mjs';

export const REGISTER_PATH = join(REPO_ROOT, 'policy/ci-secrets.json');

const REQUIRED_FIELDS = ['name', 'workflow', 'job', 'justification', 'approvedBy'];
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The register as committed. Throws (fatal) if the file is missing or not parseable. */
export function loadRegister(path = REGISTER_PATH) {
  const register = readJson(path);
  if (!Array.isArray(register.secrets)) throw new PolicyError('policy/ci-secrets.json must contain a "secrets" array');
  return register.secrets;
}

/**
 * Structural problems with one registration, all fatal.
 *
 * Expiry is deliberately excluded here and classified separately: `exceptionProblems` reports an
 * expired entry as a problem, which is the right behaviour for every other register and the wrong one
 * for this one. Everything else it checks — required fields, date formats, `expires` before
 * `approvedOn` — stays fatal, so an unevaluable registration can never degrade into "expired but
 * harmless".
 */
export function registrationProblems(entry, today) {
  const problems = exceptionProblems(entry, REQUIRED_FIELDS, today).filter((problem) => !problem.startsWith('expired on'));
  if (typeof entry.name === 'string' && entry.name !== '' && !SECRET_NAME.test(entry.name)) {
    problems.push('name must be an UPPER_SNAKE_CASE secret name');
  }
  return problems;
}

export function findRegistration(register, name) {
  return register.find((entry) => entry.name === name);
}

/** True when a structurally valid registration is past its expiry date. `today` is YYYY-MM-DD. */
export function isExpired(entry, today) {
  return entry.expires < today;
}

/** The one deterministic wording for an expired registration: same inputs, same message. */
export function expiryMessage(entry) {
  return `CI secret ${entry.name} registration expired on ${entry.expires}: job ${entry.job} in ${entry.workflow} is disabled until the owner renews policy/ci-secrets.json`;
}

/**
 * Fatal problems with the register itself, independent of any workflow. Duplicated names are fatal
 * because two entries for one secret would make "which job may use it" ambiguous.
 */
export function registerProblems(register, today) {
  const problems = [];
  const seen = new Set();
  for (const entry of register) {
    const label = typeof entry.name === 'string' && entry.name !== '' ? entry.name : '<unnamed>';
    for (const problem of registrationProblems(entry, today)) problems.push(`policy/ci-secrets.json: ${label}: ${problem}`);
    if (seen.has(label)) problems.push(`policy/ci-secrets.json: ${label}: duplicate registration`);
    seen.add(label);
  }
  return problems;
}

/**
 * The self-gate. Returns the deterministic failure message, or undefined when the named secret may be
 * used by this workflow and job today.
 */
export function assertUsable({ name, workflow, job, register, today }) {
  const entry = findRegistration(register, name);
  if (entry === undefined) return `CI secret ${name} is not registered in policy/ci-secrets.json`;
  const problems = registrationProblems(entry, today);
  if (problems.length > 0) return `CI secret ${name} registration is invalid: ${problems.join('; ')}`;
  if (entry.workflow !== workflow) return `CI secret ${name} is registered for ${entry.workflow}, not ${workflow}`;
  if (entry.job !== job) return `CI secret ${name} is registered for job ${entry.job}, not ${job}`;
  if (isExpired(entry, today)) return expiryMessage(entry);
  return undefined;
}

function arg(name) {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new PolicyError(`missing ${name}`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'assert') throw new PolicyError('Usage: ci-secrets.mjs assert --name <NAME> --workflow <path> --job <job> [--today YYYY-MM-DD]');
    const today = process.argv.includes('--today') ? arg('--today') : todayUtc();
    const failure = assertUsable({ name: arg('--name'), workflow: arg('--workflow'), job: arg('--job'), register: loadRegister(), today });
    if (failure !== undefined) {
      console.error(failure);
      process.exit(1);
    }
    console.log(`CI secret ${arg('--name')} is registered and active for job ${arg('--job')} in ${arg('--workflow')}.`);
  } catch (error) {
    console.error(error instanceof PolicyError ? error.message : `ci-secrets check failed: ${String(error)}`);
    process.exit(1);
  }
}
