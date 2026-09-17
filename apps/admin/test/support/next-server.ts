import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface RunningApp {
  readonly baseUrl: string;
  /** Everything the server printed so far. */
  output(): string;
  stop(): Promise<void>;
}

/** Starts the built app with `next start` (run the build first). */
export async function startBuiltApp(env: Record<string, string>): Promise<RunningApp> {
  if (!existsSync(`${APP_DIR}/.next/BUILD_ID`)) {
    throw new Error('Build the app before running the HTTP tests.');
  }
  const port = await freePort();
  // Default binding: `next start --hostname …` makes the root path redirect to itself with next-intl.
  const childEnv = { PATH: process.env.PATH ?? '', NEXT_TELEMETRY_DISABLED: '1', ...env } as unknown as NodeJS.ProcessEnv;
  const child: ChildProcess = spawn(`${APP_DIR}/node_modules/.bin/next`, ['start', '--port', String(port)], {
    cwd: APP_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${baseUrl}/`, { redirect: 'manual' });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('next start did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return {
    baseUrl,
    output: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/g) ?? [];
}

export function nonceFromCsp(csp: string | null): string {
  const match = /'nonce-([^']+)'/.exec(csp ?? '');
  if (match?.[1] === undefined) throw new Error('no nonce in CSP');
  return match[1];
}
