import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_DIR, startBuiltApp } from './support/next-server.js';

function run(command: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const childEnv = { PATH: `${APP_DIR}/node_modules/.bin:${process.env.PATH ?? ''}`, NEXT_TELEMETRY_DISABLED: '1', ...env } as unknown as NodeJS.ProcessEnv;
    const child = spawn('sh', ['-c', command], { cwd: APP_DIR, env: childEnv });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const startScript = (JSON.parse(readFileSync(`${APP_DIR}/package.json`, 'utf8')) as { scripts: Record<string, string> }).scripts.start ?? '';

/** Obviously fake, 43 base64url characters like the real format. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';
/** A complete, valid server environment. Individual tests remove one variable to prove it is required. */
const VALID_ENV = { API_BASE_URL: 'http://placeholder-internal-host:9', INTERNAL_BFF_CREDENTIAL: CREDENTIAL };

describe('R4-B: local start preflight', () => {
  it('the start script runs the preflight before next start', () => {
    expect(startScript).toMatch(/^node \.\.\/\.\.\/scripts\/preflight-next-env\.mjs web && next start --port \d+$/);
  });

  it('stops with exit code 1 before Next.js starts when API_BASE_URL is missing', async () => {
    const result = await run(startScript, { INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(result.code).toBe(1);
    expect(result.output).toContain('web: Invalid or missing environment variables: API_BASE_URL');
    expect(result.output).not.toMatch(/Next\.js|Ready/);
  });

  it('stops with exit code 1 when API_BASE_URL is invalid, without printing it', async () => {
    const result = await run(startScript, { API_BASE_URL: 'https://user:placeholder-credential@api.internal', INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain('placeholder-credential');
    expect(result.output).not.toMatch(/Next\.js|Ready/);
  });

  it('stops with exit code 1 when the internal BFF credential is missing', async () => {
    // The BFF cannot reach the API without it, so start-up fails by name rather than every request
    // failing with a 403 later.
    const result = await run(startScript, { API_BASE_URL: 'http://127.0.0.1:9' });
    expect(result.code).toBe(1);
    expect(result.output).toContain('web: Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL');
    expect(result.output).not.toMatch(/Next\.js|Ready/);
  });

  it('stops with exit code 1 when the credential is malformed, without printing it', async () => {
    const result = await run(startScript, { API_BASE_URL: 'http://127.0.0.1:9', INTERNAL_BFF_CREDENTIAL: 'placeholder-malformed-credential' });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain('placeholder-malformed-credential');
    expect(result.output).not.toMatch(/Next\.js|Ready/);
  });

  it('passes the preflight with a valid API_BASE_URL', async () => {
    const result = await run('node ../../scripts/preflight-next-env.mjs web', { API_BASE_URL: 'http://127.0.0.1:9', INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    expect(result.code).toBe(0);
    expect(result.output).toBe('');
  });
});

describe('R4-B: instrumentation start-up validation (next start without the preflight)', () => {
  it('serves nothing and logs names only when API_BASE_URL is missing', async () => {
    const app = await startBuiltApp({ INTERNAL_BFF_CREDENTIAL: CREDENTIAL });
    try {
      for (const path of ['/', '/missing']) {
        const res = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('Internal Server Error');
      }
      expect(app.output()).toContain('Invalid or missing environment variables: API_BASE_URL');
      expect(app.output()).not.toContain('"config_loaded"');
    } finally {
      await app.stop();
    }
  });

  it('logs config_loaded once without values when API_BASE_URL is set', async () => {
    const app = await startBuiltApp(VALID_ENV);
    try {
      expect((await fetch(`${app.baseUrl}/`)).status).toBe(200);
      const lines = app.output().split('\n').filter((line) => line.includes('"config_loaded"'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toEqual({ event: 'config_loaded', component: 'web', variablesValidated: 2 });
      expect(app.output()).not.toContain('placeholder-internal-host');
      expect(app.output()).not.toContain(CREDENTIAL);
    } finally {
      await app.stop();
    }
  });
});
