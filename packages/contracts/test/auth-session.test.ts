import { describe, expect, it } from 'vitest';
import {
  CurrentUserResponseSchema,
  CurrentUserSchema,
  LogoutResponseSchema,
  REFRESH_TOKEN_HEADER,
  SESSION_TOKEN_HEADER,
  SessionRefreshResponseSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The session-continuity contracts (Phase 5-A).
 *
 * The schemas are small; what they *refuse* is the point. A browser-visible body may not carry a token,
 * and the caller's identity may not carry anything but an id and a name — so both are `.strict()` and
 * both are asserted against the extra fields somebody would most plausibly add.
 */

describe('the refresh and logout bodies', () => {
  it('say only that it worked', () => {
    expect(SessionRefreshResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(LogoutResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('cannot be widened to carry a token', () => {
    for (const schema of [SessionRefreshResponseSchema, LogoutResponseSchema]) {
      expect(schema.safeParse({ status: 'ok', accessToken: 'x' }).success).toBe(false);
      expect(schema.safeParse({ status: 'ok', refreshToken: 'x' }).success).toBe(false);
      expect(schema.safeParse({ status: 'ok', session: {} }).success).toBe(false);
    }
  });
});

describe('the caller’s identity', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' };

  it('is an id and a display name', () => {
    expect(CurrentUserSchema.parse(user)).toEqual(user);
    expect(CurrentUserResponseSchema.parse({ user })).toEqual({ user });
  });

  it('allows a null display name, because the column is nullable', () => {
    expect(CurrentUserSchema.parse({ ...user, displayName: null }).displayName).toBeNull();
  });

  it('refuses an identifier that is not a uuid', () => {
    expect(CurrentUserSchema.safeParse({ ...user, id: 'nadia' }).success).toBe(false);
  });

  it('refuses every field somebody would be tempted to add', () => {
    for (const extra of [
      { email: 'nadia@test.invalid' },
      { phone: '+201000000001' },
      { role: 'seller' },
      { verificationStatus: 'verified' },
      { accessToken: 'x' },
    ]) {
      expect(CurrentUserSchema.safeParse({ ...user, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a response that carries anything beside the user', () => {
    expect(CurrentUserResponseSchema.safeParse({ user, session: {} }).success).toBe(false);
  });
});

describe('the two session headers are different headers', () => {
  it('so an access token cannot be spent as a refresh token', () => {
    expect(REFRESH_TOKEN_HEADER).toBe('x-refresh-token');
    expect(SESSION_TOKEN_HEADER).toBe('x-session-token');
    expect(REFRESH_TOKEN_HEADER).not.toBe(SESSION_TOKEN_HEADER);
  });
});

describe('the documented operations', () => {
  const doc = generateOpenApiDocument();

  it('name the three session routes', () => {
    expect(doc.paths?.['/v1/auth/refresh']?.post?.operationId).toBe('postV1AuthRefresh');
    expect(doc.paths?.['/v1/auth/logout']?.post?.operationId).toBe('postV1AuthLogout');
    expect(doc.paths?.['/v1/users/me']?.get?.operationId).toBe('getV1UsersMe');
  });

  it('document no request body on any of them', () => {
    expect(doc.paths?.['/v1/auth/refresh']?.post?.requestBody).toBeUndefined();
    expect(doc.paths?.['/v1/auth/logout']?.post?.requestBody).toBeUndefined();
    expect(doc.paths?.['/v1/users/me']?.get?.requestBody).toBeUndefined();
  });

  it('never document a route that names an account', () => {
    const paths = Object.keys(doc.paths ?? {});
    const userPaths = paths.filter((path) => path.startsWith('/v1/users/')).sort();
    expect(userPaths).toEqual([
      '/v1/users/me',
      '/v1/users/me/addresses',
      '/v1/users/me/addresses/{addressId}',
      '/v1/users/me/blocks',
      '/v1/users/me/blocks/{reference}',
      '/v1/users/me/contact/phone/start',
      '/v1/users/me/contact/phone/verify',
      '/v1/users/me/favorites',
      '/v1/users/me/favorites/{listingId}',
      '/v1/users/me/profile',
      '/v1/users/me/saved-searches',
      '/v1/users/me/saved-searches/{savedSearchId}',
      '/v1/users/me/settings',
    ]);
    // The list above will grow; the rule will not. Every path under /v1/users is the caller's own,
    // and the only identifiers any of them accept name a row, never a person.
    for (const path of userPaths) {
      expect(path === '/v1/users/me' || path.startsWith('/v1/users/me/')).toBe(true);
    }
    const parameters = userPaths.flatMap((path) => path.match(/\{[^}]+\}/g) ?? []);
    expect(parameters).toEqual([
      '{addressId}',
      // 0103's `{reference}` is an opaque token the API minted over a row it had just returned to this
      // caller, not an identifier for anything — which is the whole point of it: `public.user_blocks` has no
      // surrogate key, so the only thing that names one of its rows is the blocked account, and that is
      // exactly the value this rule keeps out of a URL.
      '{reference}',
      '{listingId}',
      '{savedSearchId}',
    ]);
  });
});
