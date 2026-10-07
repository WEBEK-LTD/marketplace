import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_SESSION_BYTES,
  ANALYTICS_SESSION_COOKIE_NAME,
  ANALYTICS_SESSION_DOMAIN,
  DEVICE_ID_DOMAIN,
  MIN_ANALYTICS_SESSION_KEY_LENGTH,
  PSEUDONYMOUS_ID_DOMAIN,
  analyticsSessionHash,
  isAnalyticsSessionId,
  newAnalyticsSessionId,
} from '../src/index.js';

/**
 * The analytics session identity (0101, owner decision 4).
 *
 * The properties that matter are about **separation** and about **who computes the digest**. A caller cannot
 * supply a digest, because the function hashes whatever it is given; and a digest can never be correlated
 * with a device row or a log line, because the key and the domain label both differ.
 */

const KEY = 'an-analytics-session-key-of-sufficient-length-00';
const OTHER_KEY = 'a-different-key-of-sufficient-length-for-tests-0';

describe('the issued value', () => {
  it('is 256 bits of base64url', () => {
    const value = newAnalyticsSessionId();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(ANALYTICS_SESSION_BYTES);
  });

  it('is different every time', () => {
    const values = new Set(Array.from({ length: 64 }, () => newAnalyticsSessionId()));
    expect(values.size).toBe(64);
  });

  it('is recognised, and nothing else is', () => {
    expect(isAnalyticsSessionId(newAnalyticsSessionId())).toBe(true);
    for (const value of [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}/`,
      `${'a'.repeat(42)}=`,
      null,
      undefined,
      42,
      {},
      [],
    ]) {
      expect(isAnalyticsSessionId(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('is carried by a __Host- cookie, which a subdomain cannot set for the parent origin', () => {
    expect(ANALYTICS_SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });
});

describe('the digest', () => {
  it('is a SHA-256, as 32 bytes of lowercase hex', () => {
    const digest = analyticsSessionHash(KEY, newAnalyticsSessionId());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(digest!, 'hex')).toHaveLength(32);
  });

  it('is stable for one value and one key', () => {
    const id = newAnalyticsSessionId();
    expect(analyticsSessionHash(KEY, id)).toBe(analyticsSessionHash(KEY, id));
  });

  it('differs for two values', () => {
    expect(analyticsSessionHash(KEY, newAnalyticsSessionId())).not.toBe(
      analyticsSessionHash(KEY, newAnalyticsSessionId()),
    );
  });

  it('differs under a different key, so one environment cannot be matched against another', () => {
    const id = newAnalyticsSessionId();
    expect(analyticsSessionHash(KEY, id)).not.toBe(analyticsSessionHash(OTHER_KEY, id));
  });

  /**
   * The point of owner decision 4. Even if one key were misconfigured into two of the three schemes, the
   * domain labels differ, so the same input still produces three different digests and an analytics digest
   * can never be matched against a `known_devices` row or a log line.
   */
  it('is domain-separated from the device and pseudonymous-ID schemes', async () => {
    expect(ANALYTICS_SESSION_DOMAIN).not.toBe(DEVICE_ID_DOMAIN);
    expect(ANALYTICS_SESSION_DOMAIN).not.toBe(PSEUDONYMOUS_ID_DOMAIN);

    const id = newAnalyticsSessionId();
    const { createHmac } = await import('node:crypto');
    const underDeviceLabel = createHmac('sha256', KEY).update(`${DEVICE_ID_DOMAIN}${id}`).digest('hex');
    const underPseudonymLabel = createHmac('sha256', KEY)
      .update(`${PSEUDONYMOUS_ID_DOMAIN}${id}`)
      .digest('hex');

    expect(analyticsSessionHash(KEY, id)).not.toBe(underDeviceLabel);
    expect(analyticsSessionHash(KEY, id)).not.toBe(underPseudonymLabel);
  });

  it('is versioned, so the label can be rotated deliberately', () => {
    expect(ANALYTICS_SESSION_DOMAIN).toMatch(/-v1:$/);
  });

  /**
   * A caller cannot supply a digest. Hand it one and it is hashed like any other string, so there is no
   * input that reaches `listing_events.session_hash` unhashed.
   */
  it('hashes a value that is already a digest, rather than passing it through', () => {
    const id = newAnalyticsSessionId();
    const digest = analyticsSessionHash(KEY, id)!;
    // A 64-character hex string is not the shape this server issues, so it is not a session at all.
    expect(analyticsSessionHash(KEY, digest)).toBeNull();
  });

  it('is null for anything that is not a value this server issued', () => {
    for (const value of ['', 'nope', 'a'.repeat(44), null, undefined, 42, {}]) {
      expect(analyticsSessionHash(KEY, value), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses to work under a missing or short key, rather than producing a weak digest', () => {
    const id = newAnalyticsSessionId();
    expect(() => analyticsSessionHash('', id)).toThrow();
    expect(() => analyticsSessionHash('a'.repeat(MIN_ANALYTICS_SESSION_KEY_LENGTH - 1), id)).toThrow();
    expect(() =>
      analyticsSessionHash('a'.repeat(MIN_ANALYTICS_SESSION_KEY_LENGTH), id),
    ).not.toThrow();
  });

  it('never returns the value it was given', () => {
    const id = newAnalyticsSessionId();
    expect(analyticsSessionHash(KEY, id)).not.toContain(id);
  });
});
