import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';

export interface RedisOptions {
  readonly policy?: string;
  readonly password?: string;
  readonly disableConfig?: boolean;
  readonly disableInfo?: boolean;
  readonly port?: number;
}

export interface RedisInstance {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function pingOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(300);
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (data) => {
      socket.destroy();
      resolve(data.toString().startsWith('+PONG') || data.toString().startsWith('-NOAUTH'));
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('redis-server did not become available');
}

/** Starts a throwaway redis-server (no persistence). Fails loudly if the binary is missing. */
export async function startRedis(options: RedisOptions = {}): Promise<RedisInstance> {
  const port = options.port ?? (await freePort());
  const args = ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--maxmemory-policy', options.policy ?? 'noeviction'];
  if (options.password !== undefined) args.push('--requirepass', options.password);
  if (options.disableConfig === true) args.push('--rename-command', 'CONFIG', '');
  if (options.disableInfo === true) args.push('--rename-command', 'INFO', '');
  const binary = process.env.REDIS_SERVER_BIN ?? 'redis-server';
  let child: ChildProcess | undefined;

  const instance: RedisInstance = {
    port,
    url: options.password === undefined ? `redis://127.0.0.1:${port}` : `redis://:${encodeURIComponent(options.password)}@127.0.0.1:${port}`,
    async start() {
      const spawned = spawn(binary, args, { stdio: 'ignore' });
      child = spawned;
      await new Promise<void>((resolve, reject) => {
        spawned.once('error', (error) => reject(new Error(`cannot start ${binary}: ${error.message}`)));
        waitFor(() => pingOnce(port), 5_000).then(resolve, reject);
      });
    },
    async stop() {
      const current = child;
      child = undefined;
      if (current === undefined || current.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        current.once('exit', () => resolve());
        current.kill('SIGKILL');
      });
    },
  };
  await instance.start();
  return instance;
}
