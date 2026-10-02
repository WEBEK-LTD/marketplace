import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerIdentityResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import {
  SELLER_IDENTITY_STORE,
  type SellerIdentityRow,
} from '../src/sellers/seller-identity.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/sellers/me` (Phase 6-A).
 *
 * Four properties carry this suite.
 *
 * **The caller is the session.** Every attempt below to name a seller — a query parameter, a header, a
 * path — is ignored or refused, and the store is asked with the token's own user id every time. There is
 * no field anywhere in the route through which a caller could ask about a different storefront.
 *
 * **Every status is reported.** Unlike the public profile, this route tells the owner that their account is
 * pending, suspended or closed. That is the point of it existing.
 *
 * **Nothing private crosses.** The response is compared field for field against the six approved ones, and
 * the store is fed a row full of things that must not appear — a legal name, contact details, a suspension
 * reason, object paths — to prove none of them can reach the body.
 *
 * **The public route is untouched.** `/v1/sellers/{slug}` still answers exactly as 4-E left it, including
 * for the slug `me`, and a test pins the routing so a later edit cannot let one shadow the other.
 *
 * Everything is stubbed at the store boundary: no database, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';

/** A row carrying every private field 0009 holds, so their absence from the answer is a real assertion. */
function sellerRow(overrides: Partial<SellerIdentityRow> = {}): SellerIdentityRow {
  return {
    slug: 'good-shop',
    displayName: 'Good Shop',
    status: 'active',
    verificationStatus: 'verified',
    city: 'Cairo',
    countryCode: 'EG',
    ...overrides,
  };
}

const PRIVATE_VALUES = {
  legalName: 'Good Shop Trading LLC',
  contactEmail: 'private@seller.invalid',
  contactPhone: '+201555000999',
  suspensionReason: 'Repeated policy breaches, internal note',
  logoPath: 'logos/good-shop.webp',
  bannerPath: 'banners/good-shop.webp',
} as const;

interface Recorded {
  readonly identityCalls: string[];
  readonly publicCalls: string[];
  readonly tokensSeen: string[];
}

interface Doubles {
  readonly row?: SellerIdentityRow | null;
  /** Extra keys the store might hand back, to prove the service does not forward them. */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly deletedProfile?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { identityCalls: [], publicCalls: [], tokensSeen: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (token: string) => {
        recorded.tokensSeen.push(token);
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading a seller identity must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading a seller identity must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({
      userIdentity: async (userId: string) =>
        doubles.deletedProfile === true ? null : { id: userId, displayName: 'Nadia' },
    })
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({
      sellerIdentity: async (userId: string) => {
        recorded.identityCalls.push(userId);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        const row = doubles.row === undefined ? sellerRow() : doubles.row;
        if (row === null) return null;
        return { ...row, ...(doubles.extra ?? {}) };
      },
    })
    .overrideProvider(SELLER_STORE)
    .useValue({
      publicSellerBySlug: async (slug: string) => {
        recorded.publicCalls.push(slug);
        return { outcome: 'not_found' as const };
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

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function get(
  path = '/v1/sellers/me',
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method: 'GET',
    url: path,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication and the internal credential', () => {
  it('refuses a request with no session, without asking the store', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('refuses an empty session header', async () => {
    const recorded = await start();
    const response = await get('/v1/sellers/me', { [SESSION_TOKEN_HEADER]: '' });

    expect(response.status).toBe(401);
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('refuses a token the provider will not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    const response = await get();

    expect(response.status).toBe(401);
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('refuses a live token whose account no longer has a profile', async () => {
    const recorded = await start({ deletedProfile: true });
    const response = await get();

    expect(response.status).toBe(401);
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('refuses a request with no internal credential', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });

    expect(response.statusCode).toBe(403);
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('asks the provider whose token it is before reading anything', async () => {
    const recorded = await start();
    await get();

    expect(recorded.tokensSeen).toEqual([ACCESS_TOKEN]);
    expect(recorded.identityCalls).toEqual([CALLER]);
  });
});

describe('the caller is the session', () => {
  it('reads the storefront belonging to the token, and nothing else', async () => {
    const recorded = await start();
    await get();
    expect(recorded.identityCalls).toEqual([CALLER]);
  });

  it('ignores a seller named in the query string', async () => {
    const recorded = await start();
    const response = await get(`/v1/sellers/me?userId=${IMPOSTOR}&slug=other-shop`);

    expect(response.status).toBe(200);
    expect(recorded.identityCalls).toEqual([CALLER]);
  });

  it('ignores a seller named in a header', async () => {
    const recorded = await start();
    const response = await get('/v1/sellers/me', {
      'x-user-id': IMPOSTOR,
      'x-seller-slug': 'other-shop',
      'x-seller-user-id': IMPOSTOR,
    });

    expect(response.status).toBe(200);
    expect(recorded.identityCalls).toEqual([CALLER]);
  });

  // Narrowed in 6-C (the creation) and again in 6-D (the edit). What still holds in full is the half that
  // keeps the later increments out: nothing on this route replaces a storefront wholesale or deletes one.
  it('offers no way to replace wholesale or delete', async () => {
    await start();
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await app!.inject({
        method,
        url: '/v1/sellers/me',
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
        payload: { displayName: 'Renamed by a stranger' } as never,
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it('and the one write it does offer refuses a rename: it is a creation, not an editor', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sellers/me',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ displayName: 'Renamed by a stranger' }),
    });

    // No slug and no country, so the strict onboarding contract refuses it — and the 6-A reader was never
    // consulted, because a creation does not read.
    expect(response.statusCode).toBe(400);
    expect(recorded.identityCalls).toEqual([]);
  });

  it('still reads only through the 6-A reader, whatever a request claims', async () => {
    const recorded = await start();
    await get('/v1/sellers/me', { 'x-seller-user-id': IMPOSTOR });

    expect(recorded.identityCalls).toEqual([CALLER]);
  });
});

describe('the projection', () => {
  it('answers with exactly the six approved fields', async () => {
    await start();
    const response = await get();

    expect(response.status).toBe(200);
    expect(SellerIdentityResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({
      seller: {
        slug: 'good-shop',
        displayName: 'Good Shop',
        status: 'active',
        verificationStatus: 'verified',
        city: 'Cairo',
        countryCode: 'EG',
      },
    });
    expect(Object.keys(response.body['seller'] as object).sort()).toEqual([
      'city',
      'countryCode',
      'displayName',
      'slug',
      'status',
      'verificationStatus',
    ]);
  });

  it('carries no identifier of any kind', async () => {
    await start();
    const response = await get();

    expect(response.raw).not.toContain(CALLER);
    expect(response.raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    for (const absent of ['userId', 'user_id', 'sellerUserId', 'id"']) {
      expect(response.raw, absent).not.toContain(absent);
    }
  });

  it('drops every private field even when the store hands one over', async () => {
    await start({
      extra: {
        userId: CALLER,
        legalName: PRIVATE_VALUES.legalName,
        contactEmail: PRIVATE_VALUES.contactEmail,
        contactPhoneE164: PRIVATE_VALUES.contactPhone,
        suspensionReason: PRIVATE_VALUES.suspensionReason,
        logoObjectPath: PRIVATE_VALUES.logoPath,
        bannerObjectPath: PRIVATE_VALUES.bannerPath,
        bio: 'We restore mid-century furniture.',
        governorate: 'Cairo Governorate',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-09-25T00:00:00.000Z',
        verifiedAt: '2026-02-01T00:00:00.000Z',
        suspendedAt: null,
        closedAt: null,
      },
    });
    const response = await get();

    expect(response.status).toBe(200);
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(response.raw, value).not.toContain(value);
    }
    for (const key of [
      'legalName',
      'contactEmail',
      'contactPhone',
      'suspensionReason',
      'logoObjectPath',
      'bannerObjectPath',
      'bio',
      'governorate',
      'createdAt',
      'updatedAt',
      'verifiedAt',
      'suspendedAt',
      'closedAt',
    ]) {
      expect(response.raw, key).not.toContain(key);
    }
  });

  it('reports a null city as null rather than dropping the field', async () => {
    await start({ row: sellerRow({ city: null }) });
    const response = await get();

    expect(response.status).toBe(200);
    expect((response.body['seller'] as { city: unknown }).city).toBeNull();
    expect(SellerIdentityResponseSchema.safeParse(response.body).success).toBe(true);
  });
});

describe('every status', () => {
  it('reports pending, active, suspended and closed', async () => {
    for (const [status, verificationStatus] of [
      ['pending', 'unverified'],
      ['pending', 'pending'],
      ['active', 'verified'],
      ['suspended', 'verified'],
      ['closed', 'verified'],
      ['pending', 'rejected'],
    ] as const) {
      await app?.close();
      await start({ row: sellerRow({ status, verificationStatus }) });
      const response = await get();

      expect(response.status, status).toBe(200);
      expect(response.body['seller']).toMatchObject({ status, verificationStatus });
      expect(SellerIdentityResponseSchema.safeParse(response.body).success, status).toBe(true);
    }
  });

  it('does not hide a suspended account from its own owner', async () => {
    await start({ row: sellerRow({ status: 'suspended' }) });
    const response = await get();

    expect(response.status).toBe(200);
    expect((response.body['seller'] as { status: string }).status).toBe('suspended');
  });

  it('refuses a status vocabulary this API does not know, rather than passing it through', async () => {
    for (const row of [
      sellerRow({ status: 'banned' }),
      sellerRow({ status: '' }),
      sellerRow({ verificationStatus: 'in_review' }),
    ]) {
      await app?.close();
      await start({ row });
      const response = await get();
      expect(response.status, JSON.stringify(row)).toBe(503);
      expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
    }
  });
});

describe('an account that is not a seller', () => {
  it('answers 404 rather than an empty seller', async () => {
    const recorded = await start({ row: null });
    const response = await get();

    expect(response.status).toBe(404);
    expect(recorded.identityCalls).toEqual([CALLER]);
    // No fabricated storefront: the body has no `seller` at all. (`instance` echoes the request path,
    // which naturally contains the word, so the assertion is about the key rather than the text.)
    expect(response.body['seller']).toBeUndefined();
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'detail',
      'instance',
      'status',
      'title',
      'type',
    ]);
  });

  it('uses the platform’s ordinary not-found problem body', async () => {
    await start({ row: null });
    const response = await get();

    expect(response.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested resource was not found.',
      instance: '/v1/sellers/me',
    });
  });

  it('never answers 403, which would be a different sentence about the same absence', async () => {
    await start({ row: null });
    const response = await get();
    expect(response.status).not.toBe(403);
  });
});

describe('failures', () => {
  it('answers 503 when the database cannot be asked, and never a success', async () => {
    await start({ storeThrows: true });
    const response = await get();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('leaks no token and no internal detail in any answer', async () => {
    for (const doubles of [{}, { row: null }, { storeThrows: true }, { unauthenticated: true }]) {
      await app?.close();
      await start(doubles);
      const response = await get();
      for (const secret of [
        ACCESS_TOKEN,
        TEST_INTERNAL_CREDENTIAL,
        'app_private',
        'seller_identity',
        'database',
      ]) {
        expect(response.raw, secret).not.toContain(secret);
      }
    }
  });
});

describe('the public seller route is untouched', () => {
  it('still answers 404 for a slug that names nobody', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/nobody-shop',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(response.statusCode).toBe(404);
    expect(recorded.publicCalls).toEqual(['nobody-shop']);
    // And it never consulted the identity reader: two routes, two readers.
    expect(recorded.identityCalls).toHaveLength(0);
  });

  it('needs no session, exactly as before', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/some-shop',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    // 404 from the reader, not 401 from a session check that 4-E does not have.
    expect(response.statusCode).toBe(404);
  });

  it('is not shadowed by `me`: the static segment wins and the slug reader is never asked for it', async () => {
    const recorded = await start();
    const identity = await get('/v1/sellers/me');

    expect(identity.status).toBe(200);
    expect(recorded.publicCalls).toHaveLength(0);
    expect(recorded.identityCalls).toEqual([CALLER]);
  });

  it('and does not shadow `me`: a seller whose slug is literally "me" is still reached by slug', async () => {
    const recorded = await start();
    const bySlug = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me-shop',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(bySlug.statusCode).toBe(404);
    expect(recorded.publicCalls).toEqual(['me-shop']);
  });
});
