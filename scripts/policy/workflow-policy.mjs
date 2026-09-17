// Workflow policy (owner decisions E10-E15, E22-E24; Step 9). Text-based and deterministic.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, REPO_ROOT } from './lib.mjs';

const FORBIDDEN = [
  [/pull_request_target/, 'pull_request_target is not allowed'],
  [/^\s*workflow_run:/m, 'workflow_run is not allowed'],
  [/ubuntu-latest/, 'use ubuntu-24.04, not ubuntu-latest'],
  [/self-hosted/, 'self-hosted runners are not allowed'],
  [/\bsecrets\./, 'workflows must not use secrets in Phase 1'],
  [/^\s*environment:/m, 'GitHub Environments are not used in Phase 1'],
  [/:\s*write\b/, 'write permissions are not allowed'],
  [/continue-on-error:\s*true/, 'continue-on-error is not allowed'],
  [/github\.event\.(pull_request|issue|comment|head_commit|review)\.(title|body|head\.ref|message)/, 'untrusted event text must not be used in workflows'],
  [/docker:\/\//, 'container actions by image reference are not allowed'],
];

export function splitJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) return [];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) jobs.push({ name: match[1], lines: [] });
    else if (jobs.length > 0) jobs.at(-1).lines.push(line);
  }
  return jobs.map((job) => ({ name: job.name, text: job.lines.join('\n') }));
}

function steps(jobText) {
  const parts = jobText.split(/^ {6}- /m).slice(1);
  return parts.map((part) => `- ${part}`);
}

export function workflowProblems(file, text, approved, nodeVersion) {
  const problems = [];
  const at = (message) => problems.push(`${file}: ${message}`);
  if (!/^permissions: \{\}$/m.test(text)) at('top-level permissions must be {}');
  for (const [pattern, message] of FORBIDDEN) if (pattern.test(text)) at(message);
  for (const match of text.matchAll(/uses:\s*(\S+)(.*)$/gm)) {
    const ref = /^([\w.-]+\/[\w.-]+)(\/[\w./-]+)?@([0-9a-f]{40})$/.exec(match[1]);
    const comment = /^\s*#\s*(\S+)/.exec(match[2])?.[1];
    const action = ref && approved.find((a) => a.repository === ref[1]);
    if (!ref) at(`${match[1]} must be pinned to a full commit SHA`);
    else if (!action) at(`${ref[1]} is not an approved action`);
    else if (action.sha !== ref[3] || action.version !== comment) at(`${match[1]} must be ${action.repository}@${action.sha} # ${action.version}`);
    else if (ref[2] && !(action.subpaths ?? []).includes(ref[2].slice(1))) at(`${ref[1]}${ref[2]} is not an approved sub-action`);
  }
  const jobs = splitJobs(text);
  if (jobs.length === 0) at('no jobs found');
  for (const job of jobs) {
    const where = `job ${job.name}`;
    if (!/^ {4}runs-on: ubuntu-24\.04$/m.test(job.text)) at(`${where} must run on ubuntu-24.04`);
    if (!/^ {4}timeout-minutes: \d+$/m.test(job.text)) at(`${where} needs timeout-minutes`);
    if (!/^ {4}permissions:\n {6}contents: read\n/m.test(`${job.text}\n`)) at(`${where} needs permissions contents: read only`);
    const list = steps(job.text);
    if (!list[0] || !/uses: actions\/setup-node@/.test(list[0]) || !new RegExp(`node-version: ${nodeVersion.replace(/\./g, '\\.')}\\b`).test(list[0])) at(`${where} must start with setup-node ${nodeVersion}`);
    if (!list[1] || !list[1].includes('node --version') || !list[1].includes(`v${nodeVersion}`)) at(`${where} must verify node --version (v${nodeVersion}) as its second step`);
    for (const step of list) {
      if (/uses: actions\/checkout@/.test(step) && !/persist-credentials: false/.test(step)) at(`${where}: checkout needs persist-credentials: false`);
      if (/uses: actions\/cache\/save@/.test(step) && !step.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")) at(`${where}: cache writes are allowed only from main-branch pushes`);
      if (/uses: actions\/cache@/.test(step)) at(`${where}: use actions/cache/restore and actions/cache/save explicitly`);
      if (/uses: actions\/upload-artifact@/.test(step) && !/retention-days: 14\b/.test(step)) at(`${where}: artifacts must be kept for 14 days`);
      if (/uses: pnpm\/action-setup@/.test(step) && /cache:/.test(step)) at(`${where}: pnpm/action-setup caching is not used`);
      if (/\bcorepack\b|npm (i|install) -g pnpm/.test(step)) at(`${where}: pnpm is installed only through pnpm/action-setup`);
    }
  }
  return problems;
}

/**
 * The approved Dependabot configuration (owner decision E19), ignoring comments and blank lines:
 * GitHub Actions only, weekly, a 14-day cooldown (`cooldown.default-days`, supported for GitHub Actions;
 * the semver-specific cooldown keys are not), one group for all actions, at most 5 open pull requests.
 */
export const APPROVED_DEPENDABOT = Object.freeze([
  'version: 2',
  'updates:',
  '  - package-ecosystem: github-actions',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '    cooldown:',
  '      default-days: 14',
  '    groups:',
  '      github-actions:',
  '        patterns:',
  '          - "*"',
  '    open-pull-requests-limit: 5',
]);

function effectiveLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
}

export function dependabotProblems(text) {
  const problems = [];
  const lines = effectiveLines(text);
  const ecosystems = lines.map((line) => /package-ecosystem:\s*(\S+)/.exec(line)?.[1]).filter(Boolean);
  if (ecosystems.length === 0) problems.push('dependabot.yml has no updates');
  for (const ecosystem of ecosystems) if (ecosystem !== 'github-actions') problems.push(`dependabot.yml: ecosystem ${ecosystem} is not allowed in Phase 1 (pnpm 12 is not supported by Dependabot; pnpm updates stay manual under minimumReleaseAge)`);
  const cooldowns = lines.filter((line) => /^\s*cooldown:/.test(line)).length;
  const days = lines.map((line) => /^\s*default-days:\s*(\S+)$/.exec(line)?.[1]).filter(Boolean);
  if (cooldowns !== 1 || days.length !== 1 || days[0] !== '14') problems.push('dependabot.yml: the GitHub Actions update needs exactly `cooldown: default-days: 14`');
  if (lines.some((line) => /^\s*semver-(major|minor|patch)-days:/.test(line))) problems.push('dependabot.yml: semver cooldown keys are not supported for GitHub Actions');
  if (!lines.some((line) => /^\s*groups:/.test(line))) problems.push('dependabot.yml: updates must be grouped');
  if (lines.some((line) => /auto-?merge/i.test(line))) problems.push('dependabot.yml: auto-merge is not allowed');
  if (JSON.stringify(lines) !== JSON.stringify(APPROVED_DEPENDABOT)) {
    const index = APPROVED_DEPENDABOT.findIndex((expected, i) => lines[i] !== expected);
    const at = index === -1 ? APPROVED_DEPENDABOT.length : index;
    problems.push(`dependabot.yml differs from the approved configuration at effective line ${at + 1} (expected ${JSON.stringify(APPROVED_DEPENDABOT[at] ?? '<end of file>')}, found ${JSON.stringify(lines[at] ?? '<end of file>')})`);
  }
  return problems;
}

export function playwrightProblems(text) {
  const problems = [];
  if (!/retries: 0\b/.test(text)) problems.push('playwright.config.ts: retries must be 0');
  if (!/trace: 'off'/.test(text) || !/screenshot: 'off'/.test(text) || !/video: 'off'/.test(text)) problems.push('playwright.config.ts: traces, screenshots and videos must be off');
  const projects = [...text.matchAll(/devices\['([^']+)'\]/g)].map((m) => m[1]);
  if (projects.length !== 1 || projects[0] !== 'Desktop Chrome') problems.push('playwright.config.ts: Chromium (Desktop Chrome) must be the only project');
  return problems;
}

export function repositoryProblems(root = REPO_ROOT) {
  const approved = readJson(join(root, 'toolchain/github-actions.json')).actions;
  const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const dir = join(root, '.github/workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const problems = [];
  for (const file of files) problems.push(...workflowProblems(`.github/workflows/${file}`, readFileSync(join(dir, file), 'utf8'), approved, nodeVersion));
  problems.push(...dependabotProblems(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')));
  problems.push(...playwrightProblems(readFileSync(join(root, 'packages/e2e/playwright.config.ts'), 'utf8')));
  return { files, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, problems } = repositoryProblems();
  if (problems.length > 0) {
    console.error(`workflow policy failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`workflow policy passed: ${files.join(', ')}; Dependabot limited to GitHub Actions with a 14-day cooldown; Playwright Chromium-only without retries.`);
}
