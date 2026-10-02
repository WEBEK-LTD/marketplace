import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './support/app.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
/** Not a real credential; it exists so the test can prove the connection string is never printed. */
const DB_PASSWORD = 'fake-db-password-that-must-not-be-printed';
/** Not real secrets; they exist so the test can prove neither is ever printed. */
const PEPPER = 'fake-otp-pepper-that-must-not-be-printed-0123456789';
const WAABEK_KEY = 'fake-waabek-key-that-must-not-be-printed';
const BFF_CREDENTIAL = 'test-current-credential-value-not-a-real-se';
const SUPABASE_KEY = 'fake-supabase-secret-that-must-not-be-printed';

function runMain(env: Record<string, string>, onReady?: (child: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (onReady !== undefined && stdout.includes('Nest application successfully started')) {
        const ready = onReady;
        onReady = undefined;
        ready(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('graceful shutdown', () => {
  it('finishes in-flight requests before closing', async () => {
    const t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const inFlight = fetch(`http://127.0.0.1:${port}/probe/slow`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    let closedAt = 0;
    const closing = t.app.close().then(() => {
      closedAt = Date.now();
    });
    const res = await inFlight;
    const respondedAt = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers.get('connection')).toBe('close');
    expect(await res.json()).toEqual({ done: true });
    await closing;
    // Closing must not wait for the keep-alive timeout once in-flight work is done.
    expect(closedAt - respondedAt).toBeLessThan(2000);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('the built server exits with code 0 after SIGTERM', async () => {
    expect(existsSync(MAIN), 'run the build before the tests').toBe(true);
    const result = await runMain(
      {
        NODE_ENV: 'production',
        API_HOST: '127.0.0.1',
        API_PORT: '38123',
        APP_SYSTEM_DATABASE_URL: `postgresql://app_system:${DB_PASSWORD}@db.invalid:5432/marketplace`,
        DEVICE_IDENTITY_KEY: 'test-device-identity-key-not-a-real-secret-0123',
        OTP_PEPPER: PEPPER,
        PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
        WAABEK_BASE_URL: 'https://waabek.invalid',
        WAABEK_API_KEY: WAABEK_KEY,
        INTERNAL_BFF_CREDENTIAL: BFF_CREDENTIAL,
        SUPABASE_URL: 'https://supabase.invalid',
        SUPABASE_SECRET_KEY: SUPABASE_KEY,
        REDIS_URL: 'redis://127.0.0.1:6399',
        WEB_PUBLIC_ORIGIN: 'https://web.invalid',
      },
      (child) => child.kill('SIGTERM'),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Shutdown complete (SIGTERM)');
    const configLine = result.stdout.split('\n').find((line) => line.includes('"config_loaded"'));
    expect(configLine).toBeDefined();
    const event = JSON.parse(configLine ?? '{}') as Record<string, unknown>;
    expect(event).toMatchObject({ event: 'config_loaded', component: 'api', variablesValidated: 16 });
    for (const forbidden of ['38123', '127.0.0.1', 'production', 'API_PORT', 'API_HOST', 'NODE_ENV']) {
      expect(configLine).not.toContain(forbidden);
    }
    // A connection string is a credential: it must not reach stdout or stderr anywhere, not just the
    // configuration line.
    expect(result.stdout + result.stderr).not.toContain(DB_PASSWORD);
    expect(result.stdout + result.stderr).not.toContain(PEPPER);
    expect(result.stdout + result.stderr).not.toContain(WAABEK_KEY);
    expect(result.stdout + result.stderr).not.toContain(BFF_CREDENTIAL);
    expect(result.stdout + result.stderr).not.toContain(SUPABASE_KEY);
    for (const line of result.stdout.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('the built server refuses to start with invalid environment and never prints values', async () => {
    const secret = 'fake-port-value-that-must-not-be-printed';
    const result = await runMain({
      NODE_ENV: 'production',
      API_HOST: '127.0.0.1',
      API_PORT: secret,
      APP_SYSTEM_DATABASE_URL: 'postgresql://app_system@db.invalid:5432/marketplace',
  DEVICE_IDENTITY_KEY: 'test-device-identity-key-not-a-real-secret-0123',
  OTP_PEPPER: 'test-otp-pepper-value-not-a-real-secret-0123456789',
  PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
  WAABEK_BASE_URL: 'https://waabek.invalid',
  WAABEK_API_KEY: 'test-waabek-key-not-a-real-secret',
      INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SECRET_KEY: 'test-supabase-secret-not-a-real-key',
      REDIS_URL: 'redis://127.0.0.1:6399',
      WEB_PUBLIC_ORIGIN: 'https://web.invalid',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid or missing environment variables: API_PORT');
    expect(result.stderr + result.stdout).not.toContain(secret);
  });
});
