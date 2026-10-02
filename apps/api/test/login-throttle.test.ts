import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnforcementUnavailableError, LoginThrottledError } from '../src/auth/auth-errors.js';
import {
  LOGIN_THROTTLE_BUCKETS,
  LoginThrottleService,
  type ThrottleCounter,
} from '../src/auth/login-throttle.service.js';

/**
 * The C-1 throttle.
 *
 * Two properties are worth proving separately from the endpoint tests: that the approved numbers are
 * the ones actually used, and that the tier order degrades in the approved direction — Redis, then the
 * durable counter, then a refusal. The last step is the one that must never be got wrong: a counter
 * that cannot answer must not be read as "zero so far".
 */

const IDENTIFIER = createHash('sha256').update('person@example.test').digest();
const IP = createHash('sha256').update('203.0.113.7').digest();

interface Call {
  readonly bucket: string;
  readonly windowSeconds: number;
  readonly limit: number;
}

function counter(behaviour: (call: Call) => boolean | Error, log: Call[] = []): ThrottleCounter & { calls: Call[] } {
  return {
    calls: log,
    async hit(bucket, _subject, windowSeconds, limit) {
      const call = { bucket, windowSeconds, limit };
      log.push(call);
      const outcome = behaviour(call);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

describe('the login throttle', () => {
  it('uses exactly the approved buckets, limits and windows', async () => {
    const redis = counter(() => true);
    const service = new LoginThrottleService(redis, counter(() => true));

    await service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: IP });

    expect(redis.calls).toEqual([
      { bucket: 'login_identifier', windowSeconds: 900, limit: 10 },
      { bucket: 'login_ip', windowSeconds: 900, limit: 60 },
      { bucket: 'login_ip_burst', windowSeconds: 60, limit: 5 },
    ]);
    // And the constants themselves, so a future edit to either has to change both.
    expect(LOGIN_THROTTLE_BUCKETS.identifier).toEqual({ name: 'login_identifier', limit: 10, windowSeconds: 900 });
    expect(LOGIN_THROTTLE_BUCKETS.ip).toEqual({ name: 'login_ip', limit: 60, windowSeconds: 900 });
    expect(LOGIN_THROTTLE_BUCKETS.ipBurst).toEqual({ name: 'login_ip_burst', limit: 5, windowSeconds: 60 });
  });

  it('skips the IP buckets when the client IP is unknown rather than sharing one key', async () => {
    const redis = counter(() => true);
    const service = new LoginThrottleService(redis, counter(() => true));

    await service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: null });

    expect(redis.calls.map((call) => call.bucket)).toEqual(['login_identifier']);
  });

  it('rejects when any bucket is over its limit, and still counts the others', async () => {
    const redis = counter((call) => call.bucket !== 'login_ip_burst');
    const service = new LoginThrottleService(redis, counter(() => true));

    await expect(service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: IP })).rejects.toBeInstanceOf(
      LoginThrottledError,
    );
    // A refused request still happened: not counting it would let a client stay under the other limits
    // forever by tripping the burst limit first.
    expect(redis.calls).toHaveLength(3);
  });

  it('falls back to the durable counter when Redis fails, without losing the decision', async () => {
    const durable = counter(() => false);
    const service = new LoginThrottleService(counter(() => new Error('redis down')), durable);

    await expect(service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: null })).rejects.toBeInstanceOf(
      LoginThrottledError,
    );
    expect(durable.calls).toHaveLength(1);
  });

  it('refuses the request when neither counter can answer: never fail open', async () => {
    const service = new LoginThrottleService(
      counter(() => new Error('redis down')),
      counter(() => new Error('database down')),
    );

    await expect(service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: IP })).rejects.toBeInstanceOf(
      EnforcementUnavailableError,
    );
  });

  it('works with no Redis tier configured at all', async () => {
    const durable = counter(() => true);
    const service = new LoginThrottleService(null, durable);

    await service.assertWithinLimits({ identifierHash: IDENTIFIER, ipHash: IP });

    expect(durable.calls).toHaveLength(3);
  });
});
