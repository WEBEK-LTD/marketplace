// Currency-literal check (owner decision E3; v5.2: "CI fails on currency literals outside migrations,
// seeds and tests"). Uppercase ISO 4217 codes as whole tokens: TypeScript/JavaScript files are checked
// through their syntax tree (string/template literals, JSX text, regular expressions and identifiers;
// comments are ignored); other text files line by line. Currency symbols are not part of this rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readJson, REPO_ROOT, repositoryFiles } from './lib.mjs';

export const EXCLUDED = [
  { pattern: /^supabase\/migrations\//, reason: 'migrations' },
  { pattern: /^supabase\/seed[^/]*\.sql$/, reason: 'seeds' },
  { pattern: /(^|\/)seeds?\//, reason: 'seeds' },
  { pattern: /(^|\/)tests?\//, reason: 'tests' },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, reason: 'tests' },
  { pattern: /\.mdx?$/i, reason: 'Markdown and specification files' },
];

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz|tgz|pdf)$/i;
const TOKEN = /(?<![A-Za-z0-9_])[A-Z]{3}(?![A-Za-z0-9_])/g;

export function exclusionFor(path) {
  return EXCLUDED.find((rule) => rule.pattern.test(path))?.reason;
}

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Findings for one file: { line, token, via }. */
export function findCurrencyLiterals(path, text, codes) {
  const findings = [];
  const add = (line, value, via) => {
    for (const match of value.matchAll(TOKEN)) if (codes.has(match[0])) findings.push({ line, token: match[0], via });
  };
  if (CODE.test(path)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    const visit = (node) => {
      if (
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) || ts.isRegularExpressionLiteral(node) ||
        ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
      ) {
        add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, node.text, 'syntax tree');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else {
    text.split('\n').forEach((line, index) => add(index + 1, line, 'text'));
  }
  return findings;
}

export function allowlistProblems(allowlist, files) {
  const problems = [];
  for (const entry of allowlist.entries) {
    if (typeof entry.path !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '') problems.push(`allowlist entry needs path and reason: ${JSON.stringify(entry)}`);
    else if (!files.includes(entry.path)) problems.push(`allowlist entry for a missing file: ${entry.path}`);
    if (entry.token !== undefined && !/^[A-Z]{3}$/.test(entry.token)) problems.push(`allowlist token must be a three-letter code: ${entry.path}`);
  }
  return problems;
}

export function scanRepository(root = REPO_ROOT) {
  const codes = new Set(readJson(join(root, 'policy/iso4217-currencies.json')).codes);
  const allowlist = readJson(join(root, 'policy/currency-literal-allowlist.json'));
  const files = repositoryFiles(root);
  const problems = allowlistProblems(allowlist, files);
  const excluded = {};
  let scanned = 0;
  for (const path of files) {
    const reason = exclusionFor(path);
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    if (BINARY.test(path)) continue;
    const buffer = readFileSync(join(root, path));
    if (buffer.includes(0)) continue;
    if (allowlist.entries.some((e) => e.path === path && e.token === undefined)) continue;
    scanned += 1;
    for (const finding of findCurrencyLiterals(path, buffer.toString('utf8'), codes)) {
      if (allowlist.entries.some((e) => e.path === path && e.token === finding.token)) continue;
      problems.push(`${path}:${finding.line}: currency literal ${finding.token} (${finding.via})`);
    }
  }
  return { scanned, excluded, codes: codes.size, allowlistEntries: allowlist.entries.length, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = scanRepository();
  if (result.problems.length > 0) {
    console.error(`currency-literal check failed:\n  ${result.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`currency-literal check passed: ${result.scanned} files scanned for ${result.codes} ISO 4217 codes; excluded ${JSON.stringify(result.excluded)}; ${result.allowlistEntries} reviewed allowlist entries.`);
}
