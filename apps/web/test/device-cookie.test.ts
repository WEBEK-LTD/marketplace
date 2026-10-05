import { DeviceIdentity } from '@repo/server-config';
import { describe, expect, it } from 'vitest';
import { handleLogin } from '../src/server/bff/login';
import { DEVICE_COOKIE, deviceCookie, readDeviceCookie } from '../src/server/bff/device-cookie';

/**
 * The C-15 device cookie, at the browser boundary.
 *
 * Two things are being pinned. The cookie's attributes, exactly as approved — a wrong one here is a
 * device value readable by JavaScript or sendable cross-site, which is the whole risk this cookie
 * carries. And the login handler's behaviour around it: issued once for a browser that has none, kept
 * as-is for one that already has, never handed out on a failed login, and never in the body.
 */

const ACCESS = 'access-token-value-not-a-real-token';
const REFRESH = 'refresh-token-value-not-a-real-token';
const ORIGIN = 'https://web.test';

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

function post(cookieHeader?: string): Request {
  return new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      host: 'web.test',
      'x-forwarded-proto': 'https',
      ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
    },
    body: JSON.stringify({ identifier: 'a@b.test', password: 'correct horse battery' }),
  });
}

interface Seen {
  readonly deviceHeader: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value: Seen }, rotated?: string): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.value = { deviceHeader: headers.get('x-device-id') };
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': status === 200 ? 'application/json' : 'application/problem+json',
        ...(rotated === undefined ? {} : { 'x-device-id-rotated': rotated }),
      },
    });
  }) as unknown as typeof fetch;
}

function setCookies(response: Response): string[] {
  const getter = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(response.headers);
  const single = response.headers.get('set-cookie');
  return single === null ? [] : single.split(/,\s*(?=__Host-)/);
}

function deviceCookieFrom(response: Response): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${DEVICE_COOKIE.name}=`));
}

const success = { status: 'ok', session: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 } };

describe('the device cookie', () => {
  it('is named and scoped exactly as approved', () => {
    expect(DEVICE_COOKIE.name).toBe('__Host-mp_device_id');
    expect(DEVICE_COOKIE.maxAgeSeconds).toBe(31_536_000);
  });

  it('carries every approved attribute and no Domain', () => {
    const value = DeviceIdentity.issue();
    const cookie = deviceCookie(value);
    expect(cookie.startsWith(`${DEVICE_COOKIE.name}=${value};`)).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=31536000']) {
      expect(cookie).toContain(attribute);
    }
    // `__Host-` forbids it, and C-8 and C-15 both say so in words.
    expect(cookie).not.toContain('Domain');
    expect(cookie).not.toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=None');
  });

  it('refuses to write a value this server did not issue', () => {
    for (const bad of ['', 'not-a-device-value', `${DeviceIdentity.issue()}x`]) {
      expect(() => deviceCookie(bad)).toThrow(RangeError);
    }
  });

  it('reads only its own cookie, and only a well-formed value', () => {
    const value = DeviceIdentity.issue();
    expect(readDeviceCookie(`${DEVICE_COOKIE.name}=${value}`)).toBe(value);
    expect(readDeviceCookie(`other=1; ${DEVICE_COOKIE.name}=${value}; more=2`)).toBe(value);
    expect(readDeviceCookie(null)).toBeNull();
    expect(readDeviceCookie('other=1')).toBeNull();
    expect(readDeviceCookie(`${DEVICE_COOKIE.name}=`)).toBeNull();
    expect(readDeviceCookie(`${DEVICE_COOKIE.name}=tampered-value`)).toBeNull();
  });
});

describe('the login handler and the device', () => {
  it('issues one for a browser that has none, and sends it to the API', async () => {
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(), { env: ENV, fetch: apiReturns(200, success, seen) });

    expect(response.status).toBe(200);
    const cookie = deviceCookieFrom(response);
    expect(cookie).toBeDefined();
    const issued = cookie!.slice(`${DEVICE_COOKIE.name}=`.length).split(';')[0]!;
    expect(DeviceIdentity.isWellFormed(issued)).toBe(true);
    // The same value the API was told about, so the digest it stores matches the cookie the browser keeps.
    expect(seen.value.deviceHeader).toBe(issued);
  });

  it('issues a different value every time', async () => {
    const seen = { value: { deviceHeader: null } as Seen };
    const first = await handleLogin(post(), { env: ENV, fetch: apiReturns(200, success, seen) });
    const second = await handleLogin(post(), { env: ENV, fetch: apiReturns(200, success, seen) });
    expect(deviceCookieFrom(first)).not.toBe(deviceCookieFrom(second));
  });

  it('keeps the value a browser already has, and sets no cookie for it', async () => {
    const existing = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=${existing}`), {
      env: ENV,
      fetch: apiReturns(200, success, seen),
    });

    expect(seen.value.deviceHeader).toBe(existing);
    expect(deviceCookieFrom(response)).toBeUndefined();
    // The session cookies are still set; only the device one is skipped.
    expect(setCookies(response)).toHaveLength(2);
  });

  it('replaces a tampered value rather than forwarding it', async () => {
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=../../etc/passwd`), {
      env: ENV,
      fetch: apiReturns(200, success, seen),
    });

    expect(seen.value.deviceHeader).not.toBe('../../etc/passwd');
    expect(DeviceIdentity.isWellFormed(seen.value.deviceHeader ?? '')).toBe(true);
    expect(deviceCookieFrom(response)).toBeDefined();
  });

  it('sets no device cookie when the login fails', async () => {
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(), {
      env: ENV,
      fetch: apiReturns(401, { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'AUTHENTICATION_FAILED' }, seen),
    });

    expect(response.status).toBe(401);
    expect(deviceCookieFrom(response)).toBeUndefined();
  });

  it('never puts the device value in the body', async () => {
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(), { env: ENV, fetch: apiReturns(200, success, seen) });
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    expect(body).not.toContain(seen.value.deviceHeader ?? 'unreachable');
  });
});

describe('the device cookie and a revoked device', () => {
  it('replaces the browser\u2019s cookie with the value the API issued', async () => {
    const revoked = DeviceIdentity.issue();
    const fresh = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=${revoked}`), {
      env: ENV,
      fetch: apiReturns(200, success, seen, fresh),
    });

    // The revoked value went up, and the replacement came back down as the cookie.
    expect(seen.value.deviceHeader).toBe(revoked);
    const cookie = deviceCookieFrom(response);
    expect(cookie).toBeDefined();
    expect(cookie!.startsWith(`${DEVICE_COOKIE.name}=${fresh};`)).toBe(true);
    expect(cookie).not.toContain(revoked);
  });

  it('writes the replacement with exactly the approved attributes', async () => {
    const fresh = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=${DeviceIdentity.issue()}`), {
      env: ENV,
      fetch: apiReturns(200, success, seen, fresh),
    });

    const cookie = deviceCookieFrom(response)!;
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=31536000']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain('Domain');
  });

  it('sets exactly one device cookie, never two', async () => {
    const fresh = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(), { env: ENV, fetch: apiReturns(200, success, seen, fresh) });
    expect(setCookies(response).filter((c) => c.startsWith(`${DEVICE_COOKIE.name}=`))).toHaveLength(1);
    // A rotation while the browser had none still yields the API's value, not the one issued here.
    expect(deviceCookieFrom(response)!.startsWith(`${DEVICE_COOKIE.name}=${fresh};`)).toBe(true);
  });

  it('ignores a rotation header that is not a value this server issues', async () => {
    const existing = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=${existing}`), {
      env: ENV,
      fetch: apiReturns(200, success, seen, 'not-a-device-value'),
    });
    expect(deviceCookieFrom(response)).toBeUndefined();
  });

  it('keeps the replacement out of the body', async () => {
    const fresh = DeviceIdentity.issue();
    const seen = { value: { deviceHeader: null } as Seen };
    const response = await handleLogin(post(`${DEVICE_COOKIE.name}=${DeviceIdentity.issue()}`), {
      env: ENV,
      fetch: apiReturns(200, success, seen, fresh),
    });
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    expect(body).not.toContain(fresh);
  });
});
