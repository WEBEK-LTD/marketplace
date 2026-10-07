import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { WEB_IS_LOCAL, WEB_PORT } from './urls.js';

// TOOL-7b (owner decision E6): Chromium-only smoke tests of the public marketplace and the staff console.
// Playwright 1.62.1 pins Chrome for Testing 151.0.7922.34 (Playwright revision 1234); CI installs it with
// `playwright install --with-deps chromium`. No traces, screenshots or videos are kept.
//
// One server since 0108, serving both surfaces: the marketplace at `/` and the console at `/admin`.
//
// A deployed target is addressed, never started: `E2E_WEB_URL` (see `urls.ts`) points the run at something already
// running — a Netlify deploy, say — and nothing is started here. Nothing about the specs changes, because they
// assert what holds whether or not the API behind the target can be reached, which is the whole point of being able
// to deploy the site before the API exists.

/**
 * A throwaway internal BFF credential for the smoke run, generated fresh in this process.
 *
 * The Next.js server validates its whole configuration at start-up (R4-B), and
 * `INTERNAL_BFF_CREDENTIAL` is required there, so without one the server does not start and Playwright
 * times out waiting for it. 32 random bytes as base64url is exactly the 43-character shape the shared
 * validator requires, so the real rule is satisfied rather than relaxed.
 *
 * It is generated, never stored: not committed, not written to a file, not a repository secret, and
 * never printed — the servers run with `stdout: 'ignore'`, and the configuration logs names only, never
 * values (R11). The smoke pages never call the API, so nothing ever presents it; it exists only to let
 * start-up validation succeed. A fresh value per run means there is nothing to leak between runs.
 */
const SMOKE_INTERNAL_BFF_CREDENTIAL = randomBytes(32).toString('base64url');

function nextServer(port: number) {
  return {
    command: `node_modules/.bin/next start --port ${port}`,
    cwd: '../../apps/web',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Placeholder server-only configuration; the smoke pages never call the API.
    env: {
      API_BASE_URL: 'http://127.0.0.1:9',
      INTERNAL_BFF_CREDENTIAL: SMOKE_INTERNAL_BFF_CREDENTIAL,
      // Optional in the inventory and supplied here anyway, so the smoke server runs in the shape it will
      // have once a domain exists. A reserved test host — the smoke pages never ask for a sitemap, and no real
      // domain is named anywhere in this repository.
      PUBLIC_WEB_ORIGIN: 'https://smoke.test',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
  };
}

/**
 * The server this run has to start itself, if any.
 *
 * A deployed target is already running, so starting a local copy would both waste a build and make a failure
 * ambiguous — the suite would be addressing one and Playwright waiting on the other. With no deployed target this
 * is one local server; with one, it is empty and Playwright starts nothing.
 */
const localServers = WEB_IS_LOCAL ? [nextServer(WEB_PORT)] : [];

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(localServers.length === 0 ? {} : { webServer: localServers }),
});
