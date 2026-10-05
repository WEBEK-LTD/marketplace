import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ENV_INVENTORY,
  MIN_PSEUDONYMOUS_KEY_LENGTH,
  PSEUDONYMOUS_ID_DOMAIN,
  PSEUDONYMOUS_ID_FIELD,
  PSEUDONYMOUS_ID_PREFIX,
  PseudonymousUserId,
} from '../src/index.js';

/**
 * The pseudonymous user ID (C-13).
 *
 * Two properties carry the whole decision: the value must be stable for one key, and it must be
 * useless to anyone who does not hold that key. Everything below is one of those two, plus the
 * guarantee that the key itself cannot escape through the object that holds it.
 */

const KEY_A = 'key-a-pseudonymous-user-id-not-a-real-secret';
const KEY_B = 'key-b-pseudonymous-user-id-not-a-real-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const a = new PseudonymousUserId(KEY_A);
const b = new PseudonymousUserId(KEY_B);

describe('the pseudonymous user ID', () => {
  it('is stable: the same UUID and the same key always give the same value', () => {
    expect(a.derive(USER)).toBe(a.derive(USER));
    expect(new PseudonymousUserId(KEY_A).derive(USER)).toBe(a.derive(USER));
  });

  it('is keyed: the same UUID under a different key gives a different value', () => {
    expect(b.derive(USER)).not.toBe(a.derive(USER));
  });

  it('separates users: different UUIDs under one key give different values', () => {
    expect(a.derive(OTHER_USER)).not.toBe(a.derive(USER));
  });

  it('is prefixed with usr_ and is unpadded base64url after it', () => {
    const value = a.derive(USER);
    expect(value.startsWith(PSEUDONYMOUS_ID_PREFIX)).toBe(true);
    expect(PSEUDONYMOUS_ID_PREFIX).toBe('usr_');
    const encoded = value.slice(PSEUDONYMOUS_ID_PREFIX.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
    // SHA-256 is 32 bytes, which is 43 base64 characters without padding.
    expect(encoded).toHaveLength(43);
  });

  it('separates its domain with exactly "log-user-v1:"', () => {
    expect(PSEUDONYMOUS_ID_DOMAIN).toBe('log-user-v1:');
    // Same key, same UUID, no domain label: a different value, so the label is really in the input.
    const withoutDomain = new PseudonymousUserId(KEY_A);
    expect(withoutDomain.derive(USER)).not.toBe(`${PSEUDONYMOUS_ID_PREFIX}${USER}`);
  });

  it('does not contain the raw UUID, in any casing or form', () => {
    const value = a.derive(USER);
    expect(value).not.toContain(USER);
    expect(value).not.toContain(USER.replace(/-/g, ''));
    expect(value.toLowerCase()).not.toContain(USER.slice(0, 8));
  });

  it('is not a plain SHA-256 of the user ID, with or without the domain label', () => {
    const plain = createHash('sha256').update(USER, 'utf8').digest('base64url');
    const domained = createHash('sha256').update(`${PSEUDONYMOUS_ID_DOMAIN}${USER}`, 'utf8').digest('base64url');
    expect(a.derive(USER)).not.toBe(`${PSEUDONYMOUS_ID_PREFIX}${plain}`);
    expect(a.derive(USER)).not.toBe(`${PSEUDONYMOUS_ID_PREFIX}${domained}`);
  });

  it('canonicalises the UUID, so casing and padding cannot split one person in two', () => {
    expect(a.derive(USER.toUpperCase())).toBe(a.derive(USER));
    expect(a.derive(`  ${USER}  `)).toBe(a.derive(USER));
  });

  it('never returns or prints the key', () => {
    const value = a.derive(USER);
    expect(value).not.toContain(KEY_A);
    expect(String(a)).toBe('[REDACTED]');
    expect(JSON.stringify({ key: a })).toBe('{"key":"[REDACTED]"}');
    expect(JSON.stringify(a)).toBe('"[REDACTED]"');
    // There is no property, own or inherited, that hands the key back.
    expect(Object.keys(a)).toEqual([]);
    expect(JSON.stringify(Object.getOwnPropertyNames(a))).not.toContain(KEY_A);
  });

  it('refuses a key that is too short, without naming the value', () => {
    const tooShort = 'x'.repeat(MIN_PSEUDONYMOUS_KEY_LENGTH - 1);
    expect(() => new PseudonymousUserId(tooShort)).toThrow(RangeError);
    try {
      new PseudonymousUserId(tooShort);
    } catch (error) {
      expect((error as Error).message).not.toContain(tooShort);
    }
    expect(() => new PseudonymousUserId('y'.repeat(MIN_PSEUDONYMOUS_KEY_LENGTH))).not.toThrow();
  });

  it('refuses to invent an identity for anything that is not a canonical UUID', () => {
    for (const bad of ['', '   ', 'not-a-uuid', USER.slice(0, -1), `${USER}0`]) {
      expect(() => a.derive(bad)).toThrow(RangeError);
    }
  });

  it('answers undefined rather than a placeholder where a user may legitimately be absent', () => {
    expect(a.forUser(undefined)).toBeUndefined();
    expect(a.forUser(null)).toBeUndefined();
    expect(a.forUser('')).toBeUndefined();
    expect(a.forUser('not-a-uuid')).toBeUndefined();
    expect(a.forUser(USER)).toBe(a.derive(USER));
  });

  it('names one field, so a log query works across both services', () => {
    expect(PSEUDONYMOUS_ID_FIELD).toBe('user_pseudo_id');
  });

  it('is configured as a server-only secret for the API and the worker, with no client exception', () => {
    const entry = ENV_INVENTORY.find((e) => e.name === 'PSEUDONYMOUS_USER_ID_KEY');
    expect(entry).toBeDefined();
    expect(entry?.apps).toEqual(['api', 'worker']);
    expect(entry?.required).toBe(true);
    expect(entry?.secret).toBe(true);
    expect(entry?.default).toBeNull();
    expect(entry?.status).toBe('current');
    // R5-a: only NODE_ENV may appear in a client bundle, and this is not it.
    expect(entry?.clientBundleException).toBeUndefined();
  });
});
