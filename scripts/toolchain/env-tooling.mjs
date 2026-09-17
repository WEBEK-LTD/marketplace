// Environment-configuration checks (owner decisions R3, R5, R7, R8; Phase 1 Step 7).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------- R7: process.env boundary (AST)

/** Files allowed to touch the process environment, with what exactly they may do. */
export const ENV_ACCESS_RULES = Object.freeze([
  { pattern: /^apps\/(api|worker)\/src\/config\/env\.ts$/, allow: 'any', reason: 'approved configuration module' },
  { pattern: /^apps\/(web|admin)\/src\/server\/config\.ts$/, allow: 'any', reason: 'approved configuration module (server runtime only)' },
  { pattern: /^apps\/(web|admin)\/src\/instrumentation\.ts$/, allow: { read: ['NEXT_RUNTIME'] }, reason: 'Next.js sets NEXT_RUNTIME; read only to run validation in the Node.js runtime' },
  { pattern: /^apps\/worker\/src\/runtime\/pure-js-msgpack\.ts$/, allow: { write: ['MSGPACKR_NATIVE_ACCELERATION_DISABLED'] }, reason: 'documented worker exception: switches msgpackr to pure JavaScript before BullMQ loads' },
  { pattern: /^scripts\//, allow: 'any', reason: 'tooling scripts' },
  { pattern: /^(apps|packages)\/[^/]+\/scripts\//, allow: 'any', reason: 'tooling scripts' },
  { pattern: /^packages\/contracts\/orval\.config\.mjs$/, allow: { read: ['ORVAL_OUTPUT'] }, reason: 'code-generation config (TOOL-2); ORVAL_OUTPUT is set only by scripts/check-generated.mjs' },
  { pattern: /^(apps|packages)\/[^/]+\/test\//, allow: 'any', reason: 'tests' },
  { pattern: /^packages\/db\/src\/tool3\//, allow: 'any', reason: 'TOOL-3 harness (tooling)' },
]);

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const SCRIPT_KINDS = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** Every use of the process environment in a source file. */
export function findEnvAccess(fileName, sourceText) {
  const ext = fileName.slice(fileName.lastIndexOf('.'));
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
  const found = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (node, kind, name) => found.push({ line: at(node), kind, name });

  function envUse(envNode) {
    const parent = envNode.parent;
    let name;
    let target = envNode;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === envNode) {
      name = parent.name.text;
      target = parent;
    } else if (ts.isElementAccessExpression(parent) && parent.expression === envNode) {
      name = literalText(parent.argumentExpression);
      target = parent;
      if (name === undefined) return add(envNode, 'dynamic-env-access');
    } else {
      return add(envNode, 'whole-env');
    }
    const outer = target.parent;
    const isWrite =
      (ts.isBinaryExpression(outer) && outer.left === target && outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) && outer.operand === target) ||
      (ts.isDeleteExpression(outer) && outer.expression === target);
    add(target, isWrite ? 'write' : 'read', name);
  }

  function processUse(procNode) {
    const parent = procNode.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === procNode) {
      if (parent.name.text === 'env') envUse(parent);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === procNode) {
      const member = literalText(parent.argumentExpression);
      if (member === 'env') envUse(parent);
      else if (member === undefined) add(procNode, 'dynamic-process-access');
      return;
    }
    add(procNode, 'process-alias');
  }

  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'process') {
      const p = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === node) ||
        ((ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) && p.name === node) ||
        ((ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node) ||
        (ts.isBindingElement(p) && (p.propertyName === node || p.name === node)) ||
        ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) ||
        (ts.isVariableDeclaration(p) && p.name === node) || (ts.isParameter(p) && p.name === node);
      if (!isName) processUse(node);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'process' && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
      processUse(node);
    }
    if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'process' && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
      processUse(node);
    }
    if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'env') {
      add(node, 'import-meta-env');
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (PROCESS_MODULES.has(literalText(node.moduleSpecifier))) add(node, 'process-module-import');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && PROCESS_MODULES.has(literalText(node.moduleReference.expression))) {
      add(node, 'process-module-import');
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isImport) && PROCESS_MODULES.has(literalText(node.arguments[0]))) add(node, 'process-module-import');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

export function ruleFor(relPath) {
  return ENV_ACCESS_RULES.find((rule) => rule.pattern.test(relPath));
}

export function envBoundaryViolations(relPath, sourceText) {
  const rule = ruleFor(relPath);
  if (rule?.allow === 'any') return [];
  return findEnvAccess(relPath, sourceText)
    .filter((use) => {
      if (rule === undefined) return true;
      if (use.kind === 'read') return !(rule.allow.read ?? []).includes(use.name);
      if (use.kind === 'write') return !(rule.allow.write ?? []).includes(use.name);
      return true;
    })
    .map((use) => `${relPath}:${use.line}: ${use.kind}${use.name ? ` ${use.name}` : ''}`);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.netlify', '.turbo', '.git', '.temp']);

export function sourceFiles(root, dirs = ['apps', 'packages', 'scripts']) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(relative(root, full));
    }
  };
  for (const dir of dirs) if (existsSync(join(root, dir))) walk(join(root, dir));
  return files.sort();
}

// ---------------------------------------------------------------- R8: .env files

export function envExampleProblems(app, text, expectedNames) {
  const problems = [];
  const names = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    // Exact match on the raw line: anything after "=" (even spaces) counts as a value.
    const match = /^([A-Z][A-Z0-9_]*)=$/.exec(line.replace(/\r$/, ''));
    if (match === null) problems.push(`${app}/.env.example:${index + 1}: only NAME= lines without values are allowed`);
    else names.push(match[1]);
  });
  const expected = [...expectedNames].sort();
  const actual = [...names].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(`${app}/.env.example: names differ from the inventory (expected ${expected.join(', ')}; found ${actual.join(', ') || 'none'})`);
  }
  return problems;
}

export function forbiddenEnvFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ((entry.name === '.env' || entry.name.startsWith('.env.')) && entry.name !== '.env.example') found.push(relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

// ---------------------------------------------------------------- R3: inventory documentation

export const DOC_START = '<!-- env-inventory:start (generated by `pnpm run check:env -- --write-docs`; do not edit) -->';
export const DOC_END = '<!-- env-inventory:end -->';

export function inventoryTable(inventory) {
  const rows = inventory.map((e) =>
    `| \`${e.name}\` | ${e.apps.join(', ')} | ${e.required ? 'yes' : 'no'} | ${e.default === null ? '—' : `\`${e.default}\``} | ${e.secret ? 'yes' : 'no'} | ${e.environments.join(', ')} | ${e.status} | ${e.description}${e.clientBundleException ? ` (client-bundle exception: ${e.clientBundleException})` : ''} |`,
  );
  return ['| Variable | Used by | Required | Default | Secret | Environments | Status | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function withGeneratedDocs(readme, inventory) {
  const start = readme.indexOf(DOC_START);
  const end = readme.indexOf(DOC_END);
  if (start === -1 || end === -1 || end < start) throw new Error('README.md is missing the env-inventory markers');
  return `${readme.slice(0, start + DOC_START.length)}\n${inventoryTable(inventory)}\n${readme.slice(end)}`;
}

// ---------------------------------------------------------------- R5: client bundles

export function clientBundleTerms(inventory) {
  return inventory.filter((entry) => entry.clientBundleException === undefined).map((entry) => entry.name);
}

/** Scans every file under the given client-bundle directories. Reports file and term, never content. */
export function scanClientBundles(dirs, inventory) {
  const terms = clientBundleTerms(inventory);
  const patterns = terms.map((name) => ({ name, regex: new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`) }));
  const publicPattern = /NEXT_PUBLIC_/;
  const findings = [];
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) {
        files += 1;
        const text = readFileSync(full, 'latin1');
        for (const { name, regex } of patterns) if (regex.test(text)) findings.push({ file: full, term: name });
        if (publicPattern.test(text)) findings.push({ file: full, term: 'NEXT_PUBLIC_*' });
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return { files, terms: terms.length, findings };
}
