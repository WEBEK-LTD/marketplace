// Migration policy (Phase 2). Static and deterministic: it needs no database, so it runs in the policy
// job and fails a pull request before the Supabase job ever starts.
//
// What it enforces:
//   * file names are `NNNN_lower_snake_case.sql`, versions are unique and contiguous from 0001;
//   * every file opens with its own `-- NNNN — ` header, so a copied file cannot keep the wrong number;
//   * every table created by a migration has row level security enabled by some migration;
//   * every SECURITY DEFINER function pins `search_path`;
//   * nothing is ever granted to `anon`;
//   * no password literal is written into a migration;
//   * every committed pgTAP file declares a plan;
//   * no migration after 0105 introduces a `btrim()` without an explicit character set (0105, decision 6);
//   * no reader clamps `p_limit` at a published `*_MAX_LIMIT`, which would eat the API's probe row (0106);
//   * no pgTAP de-duplication test relies on `now()` being frozen inside its transaction (0107).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.mjs';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const TESTS_DIR = 'supabase/tests';
export const FILE_NAME = /^([0-9]{4})_[a-z][a-z0-9_]*\.sql$/;
const ALLOWED_NON_SQL = new Set(['.gitkeep']);

const CREATE_TABLE = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gim;
const ENABLE_RLS = /^\s*alter\s+table\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gim;
const GRANT_TO_ANON = /^\s*grant\b[^;]*\bto\b[^;]*\banon\b/gim;
const PASSWORD_LITERAL = /\bpassword\s+('|"|\$\$)/gi;

/**
 * The first migration that may not write a loose `btrim()` (0105, owner decision 6).
 *
 * `btrim(x)` with no character set trims **spaces only**, so tabs and newlines survive it. 0105 replaced 64
 * constraints and 92 functions that had used the loose form to decide whether a required value was present —
 * one of which let a whitespace-only category name reach the public catalogue, and another of which let a
 * report close with a whitespace-only resolution note. This check is what stops the next increment
 * reintroducing it.
 *
 * Earlier migrations are exempt because they are historical and are not edited; 0105 itself is exempt because
 * it necessarily quotes the loose form in the comments that record what it replaced.
 */
const BTRIM_CHARSET_FROM = 106;

/**
 * Counts `btrim(` calls that name no character set.
 *
 * Deliberately not a regular expression. `btrim\([^,)]*\)` looks like it finds a loose call and does not: the
 * commonest shape is `btrim(coalesce(x, ''))`, whose inner comma and parens defeat it — a pattern that was
 * tried first and reported a clean result over work it had not inspected. So this walks each call to its own
 * closing parenthesis and asks whether a second top-level argument is there.
 *
 * The name is matched on a word boundary, so a function of somebody else's called `safe_btrim(` is not this
 * one. A structural gate that refuses a legitimate migration is as much a defect as one that admits a bad one.
 */
/**
 * SQL with its comments blanked out, for the checks that must read code rather than prose.
 *
 * A corrective migration has to **quote** the defect it is fixing — "`btrim(coalesce(x, \'\'))` trims spaces
 * only" is the clearest way to say what went wrong — and a scanner that reads raw text then reports the
 * explanation as a fresh violation. 0105 was exempted from its own check for exactly this reason; that
 * exemption was the workaround and this is the fix, so no future corrective migration needs one.
 *
 * Characters are replaced with spaces rather than removed, so every offset in the result still matches the
 * original file and a reported position stays true. Dollar-quoted bodies are left alone: `$$ … $$` is code,
 * and a `--` inside one is still a comment, which the line rule below handles correctly either way.
 */
export function withoutSqlComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (text[i] === "'") {
      // A quoted literal is code and is copied through, so `btrim(x, E' \t\r\n')` keeps its character set.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 1;
          else break;
        }
        j += 1;
      }
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j;
      continue;
    }
    out += text[i];
  }
  return out;
}

export function looseBtrimCalls(text) {
  const found = [];
  // The name on a word boundary, and whitespace allowed before the parenthesis, which PostgreSQL permits and
  // the first version of this check did not. The paren-walk below starts from the parenthesis this finds.
  const call = /(?<![A-Za-z0-9_])btrim[\s]*\(/g;
  let index = 0;
  for (;;) {
    call.lastIndex = index;
    const match = call.exec(text);
    if (match === null) break;
    // The call's opening parenthesis, which the paren-walk below counts from.
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let cursor = open;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      } else if (character === "'") {
        // Skip a quoted literal, including a doubled quote inside one.
        cursor += 1;
        while (cursor < text.length) {
          if (text[cursor] === "'") {
            if (text[cursor + 1] === "'") cursor += 1;
            else break;
          }
          cursor += 1;
        }
      }
    }
    const inner = text.slice(open + 1, cursor);
    let nested = 0;
    let hasCharacterSet = false;
    for (let i = 0; i < inner.length; i += 1) {
      const character = inner[i];
      if (character === '(') nested += 1;
      else if (character === ')') nested -= 1;
      else if (character === "'") {
        i += 1;
        while (i < inner.length) {
          if (inner[i] === "'") {
            if (inner[i + 1] === "'") i += 1;
            else break;
          }
          i += 1;
        }
      } else if (character === ',' && nested === 0) {
        hasCharacterSet = true;
        break;
      }
    }
    if (!hasCharacterSet) found.push(`btrim(${inner.trim().slice(0, 40)})`);
    index = cursor + 1;
  }
  return found;
}

/** Migration and test file names, sorted, with non-SQL entries reported as problems. */
export function listMigrations(root = REPO_ROOT) {
  return readdirSync(join(root, MIGRATIONS_DIR)).sort();
}

export function namingProblems(names) {
  const problems = [];
  const versions = [];
  for (const name of names) {
    if (ALLOWED_NON_SQL.has(name)) continue;
    const match = FILE_NAME.exec(name);
    if (match === null) {
      problems.push(`${MIGRATIONS_DIR}/${name}: name must be NNNN_lower_snake_case.sql`);
      continue;
    }
    versions.push(match[1]);
  }
  const sorted = [...versions].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(versions)) problems.push(`${MIGRATIONS_DIR}: files are not in version order`);
  versions.forEach((version, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (version !== expected) problems.push(`${MIGRATIONS_DIR}: expected migration ${expected}, found ${version}`);
  });
  return { problems, versions };
}

/** Each migration must introduce itself with its own number, so a duplicated file cannot lie. */
export function headerProblems(name, text) {
  if (ALLOWED_NON_SQL.has(name)) return [];
  const version = FILE_NAME.exec(name)?.[1];
  if (version === undefined) return [];
  const first = text.split('\n')[0] ?? '';
  return first.startsWith(`-- ${version} — `) ? [] : [`${MIGRATIONS_DIR}/${name}: the first line must start with "-- ${version} — "`];
}

/** Matches of a global regular expression as `schema.table` strings. */
function pairs(pattern, text) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((m) => `${m[1]}.${m[2]}`);
}

export function contentProblems(name, text) {
  const problems = [];
  const at = (message) => problems.push(`${MIGRATIONS_DIR}/${name}: ${message}`);

  GRANT_TO_ANON.lastIndex = 0;
  for (const match of text.matchAll(GRANT_TO_ANON)) at(`nothing may be granted to anon (${match[0].trim().slice(0, 80)})`);

  PASSWORD_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(PASSWORD_LITERAL)) {
    // `password __FIXTURE_PASSWORD_LITERAL__` style placeholders live in test fixtures, never here.
    at(`a password literal must never appear in a migration (${match[0].trim()})`);
  }

  // 0105, owner decision 6: a migration from 0106 on may not introduce a `btrim()` without a character set.
  const version = Number.parseInt(FILE_NAME.exec(name)?.[1] ?? '0', 10);
  if (version >= BTRIM_CHARSET_FROM) {
    // Over the code only. A corrective migration quotes the loose form in its own comments to say what it
    // is fixing, and reading those back as violations is the false positive this repository has produced
    // four times in other detectors.
    for (const call of looseBtrimCalls(withoutSqlComments(text))) {
      at(`btrim() must name its character set, as E' \\t\\r\\n' (${call}). btrim(x) trims spaces only, so tabs and newlines survive it — see 0105.`);
    }
  }

  // SECURITY DEFINER functions must pin their search path. Each function body is delimited by $$.
  const blocks = text.split(/create\s+or\s+replace\s+function|create\s+function/i).slice(1);
  for (const block of blocks) {
    const head = block.split(/\bas\s+\$\$/i)[0] ?? '';
    if (/security\s+definer/i.test(head) && !/set\s+search_path\s*=/i.test(head)) {
      at(`a SECURITY DEFINER function does not pin search_path (${head.split('(')[0].trim().slice(0, 60)})`);
    }
  }
  return problems;
}

export function rlsProblems(files) {
  const created = new Map();
  const enabled = new Set();
  for (const { name, text } of files) {
    for (const table of pairs(CREATE_TABLE, text)) if (!created.has(table)) created.set(table, name);
    for (const table of pairs(ENABLE_RLS, text)) enabled.add(table);
  }
  return [...created.entries()]
    .filter(([table]) => !enabled.has(table))
    .map(([table, name]) => `${MIGRATIONS_DIR}/${name}: ${table} is created but row level security is never enabled for it`);
}

/* ------------------------------------------------------------------------------------------------ */
/* 0106: a reader's limit ceiling may not equal a public maximum                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The three readers allowed to clamp at a public maximum (0106, owner decision 3).
 *
 * `apps/api/src/sellers/seller-read.service.ts` does not send a probe row to these: it asks for `limit: size`
 * and decides there is another page from `rows.length === size`. That convention loses no rows, so the ceiling
 * is harmless there, and changing it would change when `nextCursor` is null on an exact-multiple boundary —
 * a cursor-semantics change 0106 was forbidden to make.
 *
 * This list is deliberately short and deliberately explicit. An entry that no longer clamps at a maximum is
 * reported as a stale exemption, so the list cannot quietly outlive its reason.
 */
export const PAGINATION_CEILING_EXEMPT = Object.freeze(['seller_orders', 'seller_reviews', 'seller_promotions']);

/**
 * There is no version floor here, unlike the `btrim` rule.
 *
 * This check reads the **latest** definition of each reader, exactly as the database ends up: a reader created
 * in 0053 and replaced in 0106 reads as 0106's. So the rule can be applied to the whole corpus without
 * rewriting history, and a regression introduced in any later migration is caught by the same pass.
 */

const MAX_LIMIT_DECLARATION = /^export const ([A-Z][A-Z0-9_]*_MAX_LIMIT) = ([0-9_]+);/gm;
const FUNCTION_SPLIT = /create\s+or\s+replace\s+function\s+app_private\.|create\s+function\s+app_private\./i;
const LIMIT_CLAMP = /least\(greatest\(coalesce\(p_limit\s*,\s*\d+\s*\)\s*,\s*\d+\)\s*,\s*(\d+)\)/;

/** Every `*_MAX_LIMIT` the contracts declare, as a map of name to value. */
export function declaredMaxLimits(root = REPO_ROOT) {
  const dir = join(root, 'packages/contracts/src');
  const found = new Map();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8');
    MAX_LIMIT_DECLARATION.lastIndex = 0;
    for (const match of text.matchAll(MAX_LIMIT_DECLARATION)) {
      found.set(match[1], Number.parseInt(match[2].replaceAll('_', ''), 10));
    }
  }
  return found;
}

/**
 * The ceiling each `app_private` reader ends up with, latest definition winning.
 *
 * The search is bounded to the function's own body. 0106's verification block carries the clamp pattern as a
 * regular-expression *string*, and attributing that to the function above it would read a ceiling that does not
 * exist — the first version of this parser did exactly that.
 */
export function readerCeilings(files) {
  const ceilings = new Map();
  for (const { name, text } of files) {
    const chunks = text.split(FUNCTION_SPLIT).slice(1);
    for (const chunk of chunks) {
      const reader = /^([a-z_][a-z0-9_]*)\s*\(/.exec(chunk)?.[1];
      if (reader === undefined) continue;
      // The body ends at its own dollar-quoted terminator; anything after it belongs to another statement.
      const opened = /\bas\s+(\$[a-z_]*\$)/i.exec(chunk);
      let body = chunk;
      if (opened !== null) {
        const from = opened.index + opened[0].length;
        const closes = chunk.indexOf(opened[1], from);
        body = closes < 0 ? chunk.slice(from) : chunk.slice(from, closes);
      }
      const clamp = LIMIT_CLAMP.exec(body);
      if (clamp === null) continue;
      ceilings.set(reader, { ceiling: Number.parseInt(clamp[1], 10), migration: name });
    }
  }
  return ceilings;
}

/**
 * A reader whose ceiling equals a declared public maximum eats the API's probe row (0106).
 *
 * The API answers "is there another page?" by asking for `limit + 1` and looking for the extra row. A ceiling
 * equal to the maximum silently removes it, so at the maximum page size `nextCursor` comes back null on a page
 * that has more behind it. Nine readers did this and the rest of the platform did not; this is what stops a
 * tenth.
 *
 * The rule is narrow on purpose. It does **not** require a ceiling: thirty-seven readers clamp only the floor
 * (`greatest(coalesce(p_limit, 20), 1)`) and return exactly what they were asked for, which is correct and must
 * not be reported. It objects only to a ceiling that collides with a published maximum, which is the one shape
 * that destroys the probe row.
 */
export function paginationCeilingProblems(files, root = REPO_ROOT) {
  const maxima = new Set(declaredMaxLimits(root).values());
  if (maxima.size === 0) return ['packages/contracts/src: no *_MAX_LIMIT declarations were found to check against'];

  const ceilings = readerCeilings(files);
  const problems = [];
  const exempt = new Set(PAGINATION_CEILING_EXEMPT);

  for (const [reader, { ceiling, migration }] of [...ceilings].sort((a, b) => a[0].localeCompare(b[0]))) {
    const collides = maxima.has(ceiling);
    if (collides && !exempt.has(reader)) {
      problems.push(
        `${MIGRATIONS_DIR}/${migration}: app_private.${reader} clamps p_limit at ${ceiling}, which is a published ` +
          `*_MAX_LIMIT. The API asks for limit + 1 to detect another page, so this ceiling eats the probe row and ` +
          `reports no next page at the maximum page size. Use ${ceiling + 1} — see 0106.`,
      );
    }
    if (!collides && exempt.has(reader)) {
      problems.push(
        `scripts/policy/migrations.mjs: app_private.${reader} is listed in PAGINATION_CEILING_EXEMPT but now ` +
          `clamps at ${ceiling}, which is not a published maximum. Remove the stale exemption.`,
      );
    }
  }

  return problems;
}

/**
 * An exemption for a reader that no longer exists.
 *
 * Kept apart from `paginationCeilingProblems` because it is only answerable against the **whole** corpus: on any
 * subset, every reader not in that subset looks deleted. `checkMigrations` is the only caller that has the whole
 * corpus, so it is the only caller that asks.
 */
export function paginationExemptionProblems(files) {
  const ceilings = readerCeilings(files);
  return PAGINATION_CEILING_EXEMPT.filter((reader) => !ceilings.has(reader)).map(
    (reader) =>
      `scripts/policy/migrations.mjs: app_private.${reader} is listed in PAGINATION_CEILING_EXEMPT and no ` +
      `migration defines it with a limit clamp. Remove the stale exemption.`,
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* 0107: a pgTAP de-duplication test may not rely on a frozen clock                                   */
/* ------------------------------------------------------------------------------------------------ */

/** The event writers whose de-duplication guarantee a pgTAP file can accidentally fail to observe. */
const EVENT_WRITERS = /\brecord_(?:listing|promotion)_events\s*\(/;

const EVENT_ID_LITERAL = /'event_id'\s*,\s*'([0-9a-fA-F-]{36})'/g;
const OCCURRED_AT_VALUE = /'occurred_at'\s*,\s*([\s\S]{1,80})/;

/**
 * A frozen timestamp expression, matched as a grammar rather than as a window of text.
 *
 * `now()`, with an optional cast and an optional interval offset. Matching the expression itself is what makes
 * two identical timestamps compare equal: an earlier version captured eighty characters and normalised them,
 * which dragged the surrounding assertion text in, so `now()::text` in two places looked like two different
 * expressions and the check reported nothing.
 */
const FROZEN_TIMESTAMP = /^now\s*\(\s*\)(?:\s*::\s*[a-z]+)?(?:\s*[-+]\s*interval\s*'[^']*')?/;

/**
 * The timestamp expression beside an event id, normalised for comparison.
 *
 * Absent means the writer's own `now()` fallback, which is equally frozen. The capture runs to the next quoted
 * key because `now()::text` and `now() - interval '2 days'` both have to survive it: an earlier version stopped
 * at the first parenthesis, read `now(` and therefore missed every `now()::text` in the suite.
 */
function timestampExpression(segment) {
  const raw = OCCURRED_AT_VALUE.exec(segment)?.[1];
  if (raw === undefined) return { text: '<omitted>', frozen: true };
  const frozen = FROZEN_TIMESTAMP.exec(raw.replace(/\s+/g, ' ').trim());
  if (frozen === null) return { text: '<moving>', frozen: false };
  return { text: frozen[0].replace(/\s+/g, ' ').trim(), frozen: true };
}

/**
 * Delivering the same `event_id` twice with a frozen clock proves nothing.
 *
 * Every pgTAP file runs inside one transaction, and `now()` is transaction-stable there. So a test that
 * delivers the same event twice and asserts the second insert is a no-op passes **even when de-duplication is
 * broken**, because both deliveries land on the same `occurred_at`. That is not a hypothetical: it is why the
 * assertion in `0013_favorites_and_events.test.sql` passed while two real deliveries, in two real transactions,
 * produced two rows — a defect that survived four increments behind a green test.
 *
 * The rule is therefore narrow and specific: when a pgTAP file passes the **same `event_id` literal** to an
 * event writer more than once, those deliveries may not all carry a frozen timestamp. `clock_timestamp()`
 * advances within a transaction; an explicit distinct value works too. A single insert using `now()` is not
 * reported, because nothing about it can be vacuous.
 */
export function eventDedupClockProblems(root = REPO_ROOT) {
  const dir = join(root, TESTS_DIR);
  const problems = [];

  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (!EVENT_WRITERS.test(text)) continue;

    // Each delivery, as the event id it names and the timestamp expression beside it.
    const deliveries = new Map();
    EVENT_ID_LITERAL.lastIndex = 0;
    for (const match of text.matchAll(EVENT_ID_LITERAL)) {
      const from = match.index + match[0].length;
      // The rest of this object, up to whichever comes first: the next event id, or a closing brace depth we
      // cannot track with a regex. A generous window is fine — a wrong attribution can only under-report.
      const next = text.indexOf("'event_id'", from);
      const segment = text.slice(from, next < 0 ? Math.min(from + 400, text.length) : next);
      // Not destructured as `text`: that would shadow the file contents read above, in the same block, and
      // `text.indexOf` on the line before would then read an uninitialised binding.
      const stamp = timestampExpression(segment);
      const id = match[1].toLowerCase();
      const seen = deliveries.get(id) ?? new Map();
      // Counted per expression, because "frozen" alone is not the defect: `now()` and `now() - interval '2 days'`
      // are both transaction-stable and genuinely different from each other. Only the *same* frozen expression
      // twice gives two deliveries one timestamp, which is the vacuous case.
      if (stamp.frozen) seen.set(stamp.text, (seen.get(stamp.text) ?? 0) + 1);
      deliveries.set(id, seen);
    }

    for (const [id, expressions] of [...deliveries].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const [expression, count] of [...expressions].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (count > 1) {
          problems.push(
            `${TESTS_DIR}/${name}: event_id ${id} is delivered ${count} times with the same frozen timestamp ` +
              `(${expression}). now() is transaction-stable inside a pgTAP file, so those deliveries share one ` +
              `occurred_at and the assertion passes even when de-duplication is broken. Use clock_timestamp() or ` +
              `explicitly different values — see 0107.`,
          );
        }
      }
    }
  }
  return problems;
}

export function testPlanProblems(root = REPO_ROOT) {
  const dir = join(root, TESTS_DIR);
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const problems = names
    .filter((name) => !/select\s+plan\((\d+)\)/.test(readFileSync(join(dir, name), 'utf8')))
    .map((name) => `${TESTS_DIR}/${name}: every pgTAP file must declare a plan`);
  if (names.length === 0) problems.push(`${TESTS_DIR}: no pgTAP files found`);
  return { problems, count: names.length };
}

export function checkMigrations(root = REPO_ROOT) {
  const names = listMigrations(root);
  const { problems, versions } = namingProblems(names);
  const files = names
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, text: readFileSync(join(root, MIGRATIONS_DIR, name), 'utf8') }));
  for (const file of files) {
    problems.push(...headerProblems(file.name, file.text));
    problems.push(...contentProblems(file.name, file.text));
  }
  problems.push(...rlsProblems(files));
  problems.push(...paginationCeilingProblems(files, root));
  problems.push(...paginationExemptionProblems(files));
  problems.push(...eventDedupClockProblems(root));
  const tests = testPlanProblems(root);
  problems.push(...tests.problems);
  return { migrations: versions.length, tests: tests.count, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkMigrations();
  if (result.problems.length > 0) {
    console.error(`migration policy failed:\n  ${result.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`migration policy passed: ${result.migrations} migrations, ${result.tests} pgTAP files.`);
}
