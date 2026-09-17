import { defineConfig, devices } from '@playwright/test';
import { ADMIN_PORT, WEB_PORT } from './urls.js';

// TOOL-7b (owner decision E6): Chromium-only smoke tests of the Phase 1 web and admin surface.
// Playwright 1.62.1 pins Chrome for Testing 151.0.7922.34 (Playwright revision 1234); CI installs it with
// `playwright install --with-deps chromium`. No traces, screenshots or videos are kept.
function nextServer(app: 'web' | 'admin', port: number) {
  return {
    command: `node_modules/.bin/next start --port ${port}`,
    cwd: `../../apps/${app}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Placeholder server-only configuration; the smoke pages never call the API.
    env: { API_BASE_URL: 'http://127.0.0.1:9', NEXT_TELEMETRY_DISABLED: '1' },
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
  };
}

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [nextServer('web', WEB_PORT), nextServer('admin', ADMIN_PORT)],
});
