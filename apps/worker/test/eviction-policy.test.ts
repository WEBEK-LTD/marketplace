import { afterEach, describe, expect, it } from 'vitest';
import { EvictionPolicyError, EvictionPolicyUnverifiedError, verifyNoEviction } from '../src/redis/eviction-policy.js';
import { startRedis, type RedisInstance } from './support/redis-server.js';
import { inspector } from './support/runtime.js';

const started: RedisInstance[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.stop()));
});

async function check(options: Parameters<typeof startRedis>[0]) {
  const server = await startRedis(options);
  started.push(server);
  const client = inspector(server.url);
  try {
    return await verifyNoEviction(client);
  } finally {
    client.disconnect();
  }
}

describe('noeviction verification', () => {
  it('passes using CONFIG GET', async () => {
    await expect(check({ policy: 'noeviction' })).resolves.toBe('config');
  });

  it('falls back to INFO memory when CONFIG is blocked', async () => {
    await expect(check({ policy: 'noeviction', disableConfig: true })).resolves.toBe('info');
  });

  it('rejects another policy (CONFIG path)', async () => {
    await expect(check({ policy: 'allkeys-lru' })).rejects.toBeInstanceOf(EvictionPolicyError);
  });

  it('rejects another policy (INFO path)', async () => {
    await expect(check({ policy: 'volatile-lru', disableConfig: true })).rejects.toThrow(/found volatile-lru/);
  });

  it('refuses when the policy cannot be verified at all', async () => {
    await expect(check({ policy: 'noeviction', disableConfig: true, disableInfo: true })).rejects.toBeInstanceOf(
      EvictionPolicyUnverifiedError,
    );
  });
});
