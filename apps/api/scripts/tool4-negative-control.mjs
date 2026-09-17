// Passes only if the TOOL-4 dependency-injection test FAILS when SWC is not used and
// decorator metadata is not emitted, proving that the real run depends on SWC metadata.
import { spawnSync } from 'node:child_process';

const result = spawnSync('vitest', ['run', '--config', 'vitest.no-swc.config.ts'], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
const output = `${result.stdout}\n${result.stderr}`;

const checks = {
  'the run failed': result.status !== 0,
  'no syntax/compile error (decorators were compiled)': !/SyntaxError|Invalid or unexpected token/.test(output),
  'metadata test failed': /×\s+TOOL-4[^\n]*emits design:paramtypes metadata/.test(output) || /FAIL[^\n]*emits design:paramtypes metadata/.test(output),
  'injection test failed': /×\s+TOOL-4[^\n]*resolves constructor dependencies by type/.test(output) || /FAIL[^\n]*resolves constructor dependencies by type/.test(output),
};

const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failedChecks.length === 0) {
  console.log('TOOL-4 negative control passed: without SWC metadata the DI tests fail as expected.');
  process.exit(0);
}
console.error(`TOOL-4 negative control FAILED (${failedChecks.join('; ')}).`);
console.error(output);
process.exit(1);
