import type { Redis } from 'ioredis';

export const REQUIRED_EVICTION_POLICY = 'noeviction';

export class EvictionPolicyError extends Error {
  readonly policy: string;

  constructor(policy: string) {
    super(`Redis maxmemory-policy must be ${REQUIRED_EVICTION_POLICY}, found ${policy}.`);
    this.name = 'EvictionPolicyError';
    this.policy = policy;
  }
}

export class EvictionPolicyUnverifiedError extends Error {
  constructor() {
    super('Redis maxmemory-policy could not be verified (CONFIG and INFO unavailable).');
    this.name = 'EvictionPolicyUnverifiedError';
  }
}

async function readWithConfig(redis: Redis): Promise<string | undefined> {
  try {
    const reply = (await redis.call('CONFIG', 'GET', 'maxmemory-policy')) as unknown;
    if (Array.isArray(reply) && reply.length >= 2 && typeof reply[1] === 'string') {
      return reply[1];
    }
  } catch {
    // CONFIG may be blocked by managed providers; fall back to INFO.
  }
  return undefined;
}

async function readWithInfo(redis: Redis): Promise<string | undefined> {
  try {
    const info = (await redis.call('INFO', 'memory')) as unknown;
    if (typeof info === 'string') {
      const match = /^maxmemory_policy:(\S+)\s*$/m.exec(info);
      return match?.[1];
    }
  } catch {
    // Unavailable as well.
  }
  return undefined;
}

/** Returns how the policy was verified; throws if it is not noeviction or cannot be verified. */
export async function verifyNoEviction(redis: Redis): Promise<'config' | 'info'> {
  const fromConfig = await readWithConfig(redis);
  const policy = fromConfig ?? (await readWithInfo(redis));
  if (policy === undefined) {
    throw new EvictionPolicyUnverifiedError();
  }
  if (policy !== REQUIRED_EVICTION_POLICY) {
    throw new EvictionPolicyError(policy);
  }
  return fromConfig === undefined ? 'info' : 'config';
}
