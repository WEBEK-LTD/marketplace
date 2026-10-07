// TOOL-1 environment guards (Phase 1 Step 9). They prove that the Netlify runtime build ran the way a
// repository checkout runs it, so TOOL-1 cannot pass for environment-specific reasons (for example a
// sandbox without a git repository, where Netlify resolves paths against the app folder instead of the
// repository root). Pure functions: `scripts/toolchain/tool1-guards.test.mjs` covers them.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Values Netlify prints with `--debug`. Missing values stay undefined and are reported by the guards. */
export function parseBuildContext(log) {
  const first = (pattern) => pattern.exec(log)?.[1];
  const publishDirs = [...log.matchAll(/^\s*publish:\s*(\/\S*)\s*$/gm)].map((match) => match[1]);
  return {
    repositoryRoot: first(/^\s*repositoryRoot:\s*(\S+)\s*$/m),
    buildDir: first(/^\s*buildDir:\s*(\S+)\s*$/m),
    packagePath: first(/^\s*packagePath:\s*(\S+)\s*$/m),
    publishDirs: [...new Set(publishDirs)],
    /** Commands Netlify echoed for the configured build command. */
    buildCommands: [...log.matchAll(/^\s*\$ (.+?)\s*$/gm)].map((match) => match[1]),
  };
}

/**
 * Problems with how the build ran. `appDir` and `repoRoot` are absolute; `gitPresent` says whether the
 * tree is a git repository; `exists` is injected for tests.
 */
export function guardProblems({ app, appDir, repoRoot, context, gitPresent, exists = existsSync }) {
  const problems = [];
  const expectedPackagePath = relative(repoRoot, appDir);
  const expectedPublish = join(appDir, '.next');

  // 1. Resolved paths: the publish directory must be this app's own .next, everywhere it is resolved.
  if (context.publishDirs.length === 0) problems.push('the build log records no resolved publish directory');
  for (const dir of context.publishDirs) {
    if (dir !== expectedPublish) problems.push(`resolved publish directory ${dir} is not ${expectedPublish}`);
  }
  if (context.packagePath !== expectedPackagePath) problems.push(`packagePath is ${context.packagePath ?? 'missing'}, expected ${expectedPackagePath}`);
  if (context.buildDir !== repoRoot) problems.push(`buildDir is ${context.buildDir ?? 'missing'}, expected the repository root ${repoRoot}`);

  // 2. No doubled repository path: outputs must not land in <appDir>/<appDir relative to the repo root>.
  //    Only this one top-level path is checked; the packaged function bundle legitimately contains a
  //    repository-relative copy under functions-internal/.
  const doubled = join(appDir, expectedPackagePath, '.netlify');
  if (exists(doubled)) problems.push(`build output written to the doubled path ${doubled}`);

  // 3. Repository context: with a git repository, Netlify must resolve its root to the repository root.
  if (gitPresent && context.repositoryRoot !== repoRoot) {
    problems.push(`repositoryRoot is ${context.repositoryRoot ?? 'missing'}, expected ${repoRoot}`);
  }

  // 4. Build command: the package-scoped app build *with its dependencies*, never the root workspace build.
  //
  //    The `...` suffix is the whole point of this check now. Every workspace package exports only `dist/`,
  //    `dist/` is gitignored, and nothing has a `postinstall` or `prepare` script — so on a fresh Netlify
  //    checkout `--filter @repo/<app>` alone builds no dependency and `next build` dies loading
  //    `next.config.ts`, which imports `@repo/config`. This guard used to require that exact dependency-less
  //    string, so it would have passed the configuration that cannot build. It was blind to the defect
  //    because CI builds the graph itself first (`turbo run build --filter="@repo/<app>..."`) and TOOL-1
  //    therefore always ran against a tree where every `dist/` already existed.
  //
  //    Matched as a pattern rather than one literal string: the quoting Netlify echoes for a shell-glob
  //    argument is the builder's business, not this repository's, so `"@repo/web..."` and `@repo/web...` are
  //    both accepted. What is not accepted is the dependency-less form, or the root workspace build.
  const scoped = new RegExp(`^pnpm --filter ["']?@repo/${app}\\.\\.\\.["']? run build$`);
  const dependencyLess = new RegExp(`^pnpm --filter ["']?@repo/${app}["']? run build$`);

  if (!context.buildCommands.some((command) => scoped.test(command))) {
    problems.push(`the build log does not show \`pnpm --filter "@repo/${app}..." run build\``);
  }
  for (const command of context.buildCommands) {
    if (/^turbo run build\b/.test(command) || /^pnpm run build$/.test(command)) {
      problems.push(`the build ran the root workspace command \`${command}\``);
    }
    if (dependencyLess.test(command)) {
      problems.push(
        `the build ran \`${command}\`, which builds no workspace dependency: on a clean checkout there is no ` +
          `dist/ for @repo/config and next.config.ts cannot load. Use the \`...\` form.`,
      );
    }
  }
  return problems;
}
