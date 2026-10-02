import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID_BYTES,
  DEVICE_ID_COOKIE_NAME,
  DEVICE_ID_DOMAIN,
  DeviceIdentity,
  ENV_INVENTORY,
  MIN_DEVICE_KEY_LENGTH,
  PSEUDONYMOUS_ID_DOMAIN,
  PseudonymousUserId,
} from '../src/index.js';

/**
 * Device identity (C-15).
 *
 * The decision rests on three things: the value is unguessable and generated here rather than derived
 * from the browser, the stored form is keyed so a leaked table matches nothing, and the two keyed
 * schemes in this system can never collide with each other.
 */

const KEY_A = 'device-key-a-not-a-real-secret-0123456789';
const KEY_B = 'device-key-b-not-a-real-secret-0123456789';

const a = new DeviceIdentity(KEY_A);
const b = new DeviceIdentity(KEY_B);

describe('the device identity', () => {
  it('issues 256 random bits as unpadded base64url', () => {
    const value = DeviceIdentity.issue();
    expect(DEVICE_ID_BYTES).toBe(32);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(value).not.toContain('=');
    expect(Buffer.from(value, 'base64url')).toHaveLength(DEVICE_ID_BYTES);
  });

  it('never issues the same value twice', () => {
    const values = new Set(Array.from({ length: 500 }, () => DeviceIdentity.issue()));
    expect(values.size).toBe(500);
  });

  it('digests to exactly the 32 bytes known_devices.device_hash stores', () => {
    const digest = a.digest(DeviceIdentity.issue());
    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest).toHaveLength(32);
  });

  it('is stable for one key and different under another', () => {
    const value = DeviceIdentity.issue();
    expect(a.digest(value).equals(a.digest(value))).toBe(true);
    expect(new DeviceIdentity(KEY_A).digest(value).equals(a.digest(value))).toBe(true);
    expect(b.digest(value).equals(a.digest(value))).toBe(false);
  });

  it('separates devices', () => {
    expect(a.digest(DeviceIdentity.issue()).equals(a.digest(DeviceIdentity.issue()))).toBe(false);
  });

  it('is keyed, not a plain hash of the cookie value', () => {
    const value = DeviceIdentity.issue();
    const plain = createHash('sha256').update(value, 'utf8').digest();
    const domained = createHash('sha256').update(`${DEVICE_ID_DOMAIN}${value}`, 'utf8').digest();
    expect(a.digest(value).equals(plain)).toBe(false);
    expect(a.digest(value).equals(domained)).toBe(false);
  });

  it('uses its own domain label, exactly "device-v1:"', () => {
    expect(DEVICE_ID_DOMAIN).toBe('device-v1:');
    const value = DeviceIdentity.issue();
    const unlabelled = createHmac('sha256', KEY_A).update(value, 'utf8').digest();
    expect(a.digest(value).equals(unlabelled)).toBe(false);
  });

  it('cannot collide with the C-13 pseudonymous ID, even under one misconfigured key', () => {
    expect(DEVICE_ID_DOMAIN).not.toBe(PSEUDONYMOUS_ID_DOMAIN);
    const shared = 'one-key-misconfigured-into-both-not-a-real-secret';
    const user = '11111111-1111-4111-8111-111111111111';
    const device = new DeviceIdentity(shared);
    const pseudo = new PseudonymousUserId(shared);
    // Same key, same input string, different label: different values.
    const asDevice = createHmac('sha256', shared).update(`${DEVICE_ID_DOMAIN}${user}`, 'utf8').digest('base64url');
    expect(pseudo.derive(user)).not.toBe(`usr_${asDevice}`);
    expect(device.digestOf(user)).toBeNull(); // a UUID is not a device value at all
  });

  it('does not contain the raw cookie value or the key', () => {
    const value = DeviceIdentity.issue();
    const hex = a.digest(value).toString('hex');
    expect(hex).not.toContain(Buffer.from(value, 'utf8').toString('hex'));
    expect(hex).not.toContain(Buffer.from(KEY_A, 'utf8').toString('hex'));
  });

  it('never prints the key', () => {
    expect(String(a)).toBe('[REDACTED]');
    expect(JSON.stringify({ key: a })).toBe('{"key":"[REDACTED]"}');
    expect(JSON.stringify(a)).toBe('"[REDACTED]"');
    expect(Object.keys(a)).toEqual([]);
  });

  it('refuses a key that is too short, without naming the value', () => {
    const tooShort = 'x'.repeat(MIN_DEVICE_KEY_LENGTH - 1);
    expect(() => new DeviceIdentity(tooShort)).toThrow(RangeError);
    try {
      new DeviceIdentity(tooShort);
    } catch (error) {
      expect((error as Error).message).not.toContain(tooShort);
    }
    expect(() => new DeviceIdentity('y'.repeat(MIN_DEVICE_KEY_LENGTH))).not.toThrow();
  });

  it('accepts only values of the shape it issues', () => {
    const value = DeviceIdentity.issue();
    expect(DeviceIdentity.isWellFormed(value)).toBe(true);
    for (const bad of ['', 'short', `${value}x`, value.slice(0, -1), `${value.slice(0, -1)}+`, null, 42, undefined]) {
      expect(DeviceIdentity.isWellFormed(bad)).toBe(false);
    }
  });

  it('answers null for a cookie that is absent or malformed, rather than inventing a device', () => {
    expect(a.digestOf(undefined)).toBeNull();
    expect(a.digestOf(null)).toBeNull();
    expect(a.digestOf('')).toBeNull();
    expect(a.digestOf('not-a-device-value')).toBeNull();
    const value = DeviceIdentity.issue();
    expect(a.digestOf(value)?.equals(a.digest(value))).toBe(true);
  });

  it('throws rather than hashing something it would not have issued', () => {
    expect(() => a.digest('not-a-device-value')).toThrow(RangeError);
  });

  it('matches its own digest and nothing else', () => {
    const value = DeviceIdentity.issue();
    expect(a.matches(value, a.digest(value))).toBe(true);
    expect(a.matches(value, b.digest(value))).toBe(false);
    expect(a.matches(value, Buffer.alloc(32))).toBe(false);
  });

  it('names the C-15 cookie', () => {
    expect(DEVICE_ID_COOKIE_NAME).toBe('__Host-mp_device_id');
  });

  it('is configured as a server-only API secret, separate from the C-13 key', () => {
    const device = ENV_INVENTORY.find((e) => e.name === 'DEVICE_IDENTITY_KEY');
    const pseudonymous = ENV_INVENTORY.find((e) => e.name === 'PSEUDONYMOUS_USER_ID_KEY');
    expect(device).toBeDefined();
    expect(device?.apps).toEqual(['api']);
    expect(device?.required).toBe(true);
    expect(device?.secret).toBe(true);
    expect(device?.default).toBeNull();
    expect(device?.clientBundleException).toBeUndefined();
    // Two variables, never one: C-15 forbids reusing the pseudonymous-ID key.
    expect(device?.name).not.toBe(pseudonymous?.name);
  });
});
