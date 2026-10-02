import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DEVICE_ID_HEADER, DEVICE_ROTATED_HEADER } from '@repo/contracts';
import { DeviceIdentity } from '@repo/server-config';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AUTH_SECURITY_EVENT_STORE } from '../src/auth/auth-security-events.service.js';
import { InvalidCredentialsError } from '../src/auth/auth-errors.js';
import { LOGIN_ENFORCEMENT_STORE } from '../src/auth/login-enforcement.service.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
} from '../src/auth/login-throttle.service.js';
import { KNOWN_DEVICE_STORE, LOGIN_IDENTITY_STORE, SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Device registration at login (F6-B, owner decision C-15 §2).
 *
 * The approved integration is narrow, so the assertions are too: a successful login records the device
 * the request carried, as a digest and never as the raw value; a login without one records nothing; a
 * failed login records nothing; and a registration that fails does not take the login down with it.
 *
 * What the login itself does is out of scope here and unchanged — F2's own suite still covers it.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const IDENTIFIER = 'device-login@test.invalid';
const PASSWORD = 'correct horse battery staple';

interface Recorded {
  readonly registrations: Array<{ userId: string; deviceHash: Buffer; requestIp: string | null }>;
}

interface Doubles {
  readonly signInFails?: boolean;
  readonly registerThrows?: boolean;
  /** First registration reports the presented device as revoked (C-15 §4). */
  readonly firstIsRevoked?: boolean;
  /** The replacement registration does not take either. */
  readonly replacementFails?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { registrations: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      signInWithPassword: async () => {
        if (doubles.signInFails === true) throw new InvalidCredentialsError();
        return { userId: USER, accessToken: 'access-not-a-real-token', refreshToken: 'refresh-not-a-real-token', expiresIn: 3600 };
      },
      getUser: async () => ({ id: USER, phone: null }),
      updatePassword: async () => undefined,
      updatePhone: async () => undefined,
      revokeAllSessions: async () => undefined,
      signOut: async () => 'signed_out' as const,
    })
    .overrideProvider(LOGIN_IDENTITY_STORE)
    .useValue({ userIdForLoginIdentifier: async () => USER, loginContactConfirmed: async () => true })
    .overrideProvider(LOGIN_ENFORCEMENT_STORE)
    .useValue({
      isAccountLocked: async () => false,
      recordLoginAttempt: async () => false,
    })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue({ hit: async () => true })
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue({ hit: async () => true })
    .overrideProvider(AUTH_SECURITY_EVENT_STORE)
    .useValue({ recordAuthSecurityEvent: async () => undefined })
    .overrideProvider(KNOWN_DEVICE_STORE)
    .useValue({
      registerKnownDevice: async (input: { userId: string; deviceHash: Buffer; requestIp: string | null }) => {
        if (doubles.registerThrows === true) throw new Error('the database is unavailable');
        recorded.registrations.push(input);
        const first = recorded.registrations.length === 1;
        if (first && doubles.firstIsRevoked === true) {
          return { outcome: 'revoked', deviceId: 'aaaaaaaa-0000-4000-8000-00000000dead' };
        }
        if (!first && doubles.replacementFails === true) {
          return { outcome: 'revoked', deviceId: 'aaaaaaaa-0000-4000-8000-00000000beef' };
        }
        return { outcome: 'registered', deviceId: 'aaaaaaaa-0000-4000-8000-000000000001' };
      },
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function login(
  headers: Record<string, string> = {},
): Promise<{ status: number; raw: string; rotated: string | undefined }> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'content-type': 'application/json', [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, ...headers },
    payload: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
  });
  const rotated = response.headers[DEVICE_ROTATED_HEADER];
  return {
    status: response.statusCode,
    raw: response.payload,
    rotated: typeof rotated === 'string' ? rotated : undefined,
  };
}

describe('device registration at login', () => {
  it('records the device a successful login carried', async () => {
    const recorded = await start();
    const deviceId = DeviceIdentity.issue();
    const result = await login({ [DEVICE_ID_HEADER]: deviceId });

    expect(result.status).toBe(200);
    expect(recorded.registrations).toHaveLength(1);
    expect(recorded.registrations[0]?.userId).toBe(USER);
  });

  it('stores the keyed digest, never the value the browser holds', async () => {
    const recorded = await start();
    const deviceId = DeviceIdentity.issue();
    await login({ [DEVICE_ID_HEADER]: deviceId });

    const stored = recorded.registrations[0]?.deviceHash;
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored).toHaveLength(32);
    // Exactly the digest the configured key produces, and nothing resembling the raw value.
    expect(new DeviceIdentity(TEST_ENV.deviceIdentityKey).matches(deviceId, stored!)).toBe(true);
    expect(stored!.toString('hex')).not.toContain(Buffer.from(deviceId, 'utf8').toString('hex'));
    expect(stored!.toString('utf8')).not.toContain(deviceId);
  });

  it('gives two browsers two different digests', async () => {
    const recorded = await start();
    await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    expect(recorded.registrations).toHaveLength(2);
    expect(recorded.registrations[0]?.deviceHash.equals(recorded.registrations[1]!.deviceHash)).toBe(false);
  });

  it('gives one browser the same digest twice, which is what makes it one device', async () => {
    const recorded = await start();
    const deviceId = DeviceIdentity.issue();
    await login({ [DEVICE_ID_HEADER]: deviceId });
    await login({ [DEVICE_ID_HEADER]: deviceId });
    expect(recorded.registrations[0]?.deviceHash.equals(recorded.registrations[1]!.deviceHash)).toBe(true);
  });

  it('records nothing when the request carried no device', async () => {
    const recorded = await start();
    const result = await login();
    expect(result.status).toBe(200);
    expect(recorded.registrations).toEqual([]);
  });

  it('records nothing for a value this server would not have issued', async () => {
    const recorded = await start();
    for (const bad of ['not-a-device-value', '', `${DeviceIdentity.issue()}x`]) {
      const result = await login({ [DEVICE_ID_HEADER]: bad });
      expect(result.status).toBe(200);
    }
    expect(recorded.registrations).toEqual([]);
  });

  it('records nothing when the login fails', async () => {
    const recorded = await start({ signInFails: true });
    const result = await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    expect(result.status).toBe(401);
    expect(recorded.registrations).toEqual([]);
  });

  it('does not fail the login when the device cannot be recorded', async () => {
    await start({ registerThrows: true });
    const result = await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    // The person is signed in; a note about which browser they used is not worth their session.
    expect(result.status).toBe(200);
    expect(JSON.parse(result.raw)).toMatchObject({ status: 'ok' });
  });

  it('never returns the device value or its digest to the caller', async () => {
    await start();
    const deviceId = DeviceIdentity.issue();
    const result = await login({ [DEVICE_ID_HEADER]: deviceId });
    expect(result.raw).not.toContain(deviceId);
    expect(result.raw).not.toContain('device');
    expect(result.raw).not.toContain(TEST_ENV.deviceIdentityKey);
  });
});

describe('a revoked device at login (C-15 §4)', () => {
  it('registers a fresh device and names it for the BFF', async () => {
    const recorded = await start({ firstIsRevoked: true });
    const revokedDevice = DeviceIdentity.issue();
    const result = await login({ [DEVICE_ID_HEADER]: revokedDevice });

    expect(result.status).toBe(200);
    // Two registrations: the presented one, which came back revoked, and the replacement.
    expect(recorded.registrations).toHaveLength(2);
    const devices = new DeviceIdentity(TEST_ENV.deviceIdentityKey);
    expect(devices.matches(revokedDevice, recorded.registrations[0]!.deviceHash)).toBe(true);

    // The fresh value is a real, well-formed device, different from the revoked one, and the digest
    // that was registered is its own.
    expect(result.rotated).toBeDefined();
    expect(DeviceIdentity.isWellFormed(result.rotated)).toBe(true);
    expect(result.rotated).not.toBe(revokedDevice);
    expect(devices.matches(result.rotated!, recorded.registrations[1]!.deviceHash)).toBe(true);
  });

  it('never asks the database to change the revoked row', async () => {
    const recorded = await start({ firstIsRevoked: true });
    const revokedDevice = DeviceIdentity.issue();
    await login({ [DEVICE_ID_HEADER]: revokedDevice });

    const devices = new DeviceIdentity(TEST_ENV.deviceIdentityKey);
    const revokedDigest = devices.digest(revokedDevice);
    // The revoked digest is presented exactly once — the read that reported it — and never again. The
    // only write that follows is against a different digest, so no statement can reach that row.
    expect(recorded.registrations.filter((r) => r.deviceHash.equals(revokedDigest))).toHaveLength(1);
    expect(recorded.registrations[1]!.deviceHash.equals(revokedDigest)).toBe(false);
  });

  it('rotates nothing when the device is active', async () => {
    const recorded = await start();
    const result = await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    expect(result.rotated).toBeUndefined();
    expect(recorded.registrations).toHaveLength(1);
  });

  it('rotates nothing when the replacement registration is not accepted', async () => {
    const recorded = await start({ firstIsRevoked: true, replacementFails: true });
    const result = await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });
    expect(result.status).toBe(200);
    expect(recorded.registrations).toHaveLength(2);
    // The browser keeps what it had rather than being handed a value the database did not accept.
    expect(result.rotated).toBeUndefined();
  });

  it('keeps the fresh value out of the response body and out of the login contract', async () => {
    await start({ firstIsRevoked: true });
    const result = await login({ [DEVICE_ID_HEADER]: DeviceIdentity.issue() });

    const body = JSON.parse(result.raw) as Record<string, unknown>;
    // The approved envelope, unchanged: a status and the session, and no device field anywhere.
    expect(Object.keys(body).sort()).toEqual(['session', 'status']);
    expect(Object.keys(body['session'] as object).sort()).toEqual(['accessToken', 'expiresIn', 'refreshToken']);
    expect(result.raw).not.toContain(result.rotated!);
    expect(result.raw.toLowerCase()).not.toContain('device');
    expect(result.raw).not.toContain(TEST_ENV.deviceIdentityKey);
  });
});
