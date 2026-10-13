import { describe, expect, it } from 'vitest';
import {
  applicationPath,
  bootFailureBody,
  carriesBody,
  FUNCTION_PATH_PREFIX,
  replyHeaders,
} from '../src/netlify-bridge.js';

/**
 * Running this API as a serverless function (increment 0117).
 *
 * The function file itself is a shell — boot once, inject, return — and these are the rules it applies. They
 * are here rather than beside it because `netlify/functions/` is outside `apps/` and `packages/`: nothing
 * type-checks it and no suite runs it, so anything that can be wrong belongs in a package that is tested.
 *
 * The properties worth pinning:
 *
 * **The prefix is the deployment's, not the API's.** Every route is the path it is anywhere else, so a route
 * cannot come to depend on being mounted at `/_api` and the application stays deployable any other way.
 *
 * **A repeated header survives.** `set-cookie` arrives as an array whenever more than one cookie is set, and
 * flattening it would drop a session cookie — silently, and only for the people who got two.
 *
 * **A boot failure names nothing.** It is almost always a missing environment variable, and the name of one
 * belongs in a log only the owner can read.
 */

describe('the path the application sees', () => {
  it('strips the prefix this deployment mounts the API under', () => {
    expect(applicationPath('/_api/v1/listings')).toBe('/v1/listings');
    expect(applicationPath('/_api/health')).toBe('/health');
    expect(applicationPath('/_api/v1/listings/a-flat/media/uploads')).toBe('/v1/listings/a-flat/media/uploads');
  });

  it('answers the prefix itself with a path a router can match, never an empty string', () => {
    expect(applicationPath(FUNCTION_PATH_PREFIX)).toBe('/');
    expect(applicationPath(`${FUNCTION_PATH_PREFIX}/`)).toBe('/');
  });

  it('leaves a path that does not carry the prefix alone', () => {
    // Netlify rewrites `/_api/*` onto the function, but a function can also be reached at its own address,
    // and a path that arrives without the prefix must not have its first segment eaten.
    expect(applicationPath('/v1/listings')).toBe('/v1/listings');
    expect(applicationPath('/health')).toBe('/health');
  });

  it('does not strip a prefix that merely starts the same way', () => {
    // `/_apiary` is not `/_api` + `ary`. A `startsWith` without the separator would have made it one.
    expect(applicationPath('/_apiary/v1')).toBe('/_apiary/v1');
    expect(applicationPath('/_api-other/v1')).toBe('/_api-other/v1');
  });
});

describe('the headers a reply carries out', () => {
  it('keeps every value of a repeated header', () => {
    const headers = replyHeaders({
      'set-cookie': ['__Host-a=1; Path=/; HttpOnly', '__Host-b=2; Path=/; HttpOnly'],
      'content-type': 'application/json',
    });
    expect(headers.getSetCookie()).toEqual([
      '__Host-a=1; Path=/; HttpOnly',
      '__Host-b=2; Path=/; HttpOnly',
    ]);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('carries a numeric header as its text, and skips one with no value', () => {
    const headers = replyHeaders({ 'content-length': 42, 'x-absent': undefined, 'x-null': null });
    expect(headers.get('content-length')).toBe('42');
    // Never the string "undefined", which is what a naive `String(value)` would have written.
    expect(headers.has('x-absent')).toBe(false);
    expect(headers.has('x-null')).toBe(false);
  });

  it('carries the security headers through unchanged', () => {
    // The application sets these; this layer must not be the place they quietly stop arriving.
    const headers = replyHeaders({
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

describe('which requests have a body', () => {
  it('reads one for the methods that send one, and not for the methods that do not', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'put']) {
      expect(carriesBody(method), method).toBe(true);
    }
    for (const method of ['GET', 'HEAD', 'get', 'head']) {
      expect(carriesBody(method), method).toBe(false);
    }
  });
});

describe('a boot that failed', () => {
  it('answers the approved problem shape and names nothing about why', () => {
    const body = JSON.parse(bootFailureBody('/v1/listings')) as Record<string, unknown>;
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The service is temporarily unavailable.',
      instance: '/v1/listings',
      code: 'SERVICE_UNAVAILABLE',
    });
    // No variable name, no stack, no connection string, no provider.
    const raw = bootFailureBody('/v1/listings');
    for (const absent of ['REDIS', 'SUPABASE', 'DATABASE', 'CREDENTIAL', 'postgres', 'Error']) {
      expect(raw, absent).not.toContain(absent);
    }
  });
});
