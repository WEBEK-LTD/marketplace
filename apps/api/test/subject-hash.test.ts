import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashIdentifier, hashUserAgent } from '../src/auth/subject-hash.js';

describe('identifier hashing', () => {
  it('produces a 32-byte SHA-256 digest suitable for a bytea column', () => {
    const hash = hashIdentifier('user@example.test');
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash('sha256').update('user@example.test', 'utf8').digest())).toBe(true);
  });

  it('is stable across calls, so attempts for one identifier group together', () => {
    expect(hashIdentifier('user@example.test').equals(hashIdentifier('user@example.test'))).toBe(true);
  });

  it('normalizes case and surrounding whitespace', () => {
    const canonical = hashIdentifier('user@example.test');
    expect(hashIdentifier('  USER@Example.TEST  ').equals(canonical)).toBe(true);
  });

  it('separates different identifiers', () => {
    expect(hashIdentifier('a@example.test').equals(hashIdentifier('b@example.test'))).toBe(false);
  });

  it('rejects a blank identifier rather than hashing an empty string', () => {
    expect(() => hashIdentifier('')).toThrow(RangeError);
    expect(() => hashIdentifier('   ')).toThrow(RangeError);
  });

  it('never returns the identifier itself', () => {
    // The whole point: a leak of login_attempts must not be a leak of addresses.
    const identifier = 'victim@example.test';
    expect(hashIdentifier(identifier).toString('utf8')).not.toContain(identifier);
    expect(hashIdentifier(identifier).toString('hex')).not.toContain(Buffer.from(identifier).toString('hex'));
  });
});

describe('user agent hashing', () => {
  it('hashes a present user agent', () => {
    const hash = hashUserAgent('Mozilla/5.0');
    expect(hash).not.toBeNull();
    expect(hash).toHaveLength(32);
  });

  it('yields null for an absent or blank user agent', () => {
    expect(hashUserAgent(undefined)).toBeNull();
    expect(hashUserAgent(null)).toBeNull();
    expect(hashUserAgent('   ')).toBeNull();
  });

  it('does not normalize case, because a user agent is not an identifier', () => {
    expect(hashUserAgent('Mozilla')?.equals(hashUserAgent('mozilla') as Buffer)).toBe(false);
  });
});
