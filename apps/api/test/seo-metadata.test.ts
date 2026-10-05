import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  PublicSeoMetadataResponseSchema,
  SESSION_TOKEN_HEADER,
  SaveSeoMetadataResponseSchema,
  SeoMetadataDetailResponseSchema,
  SeoMetadataEntriesResponseSchema,
  SeoMetadataWriteResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SEO_METADATA_STORE } from '../src/admin/seo-metadata.service.js';
import { SEO_STORE } from '../src/seo/seo.service.js';
import { encodeSeoMetadataCursor } from '../src/admin/seo-metadata.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Per-entity SEO metadata at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **The public read carries no user context and is addressed by slug, never by an identifier.** It is driven with no
 * session at all and answers; the request the store receives is asserted to carry the slug, because the alternative
 * — widening two public contracts to carry a uuid — is what this design exists to avoid.
 *
 * **"Nothing stored" is a 200 with `null`, never a 404.** Asserted on the status line: most surfaces have no
 * override, and a page that could not tell that from an outage would be unrenderable for the ordinary case.
 *
 * **An answer the table could not have stored is not acted on.** The store double returns an external canonical and
 * a permissive directive, and each is dropped rather than served — the database already applies both owner rules, so
 * a value that arrives anyway means something upstream is wrong.
 *
 * **The admin surface carries nothing about the caller.** Every route is driven by a caller holding
 * `seo.metadata.read`, by callers holding each of the other console keys instead, and by the same caller at `aal1`,
 * and only the first reaches anything. A write by a read-only holder is a 404 identical to an absence.
 *
 * **A save is a replace, and the request cannot carry a structured-data field or an actor.**
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const ENTRY = 'ae000000-0000-4000-8000-00000000d7a1';
const CATEGORY = '22222222-2222-4222-8222-222222222222';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'seo.metadata.read';
const MANAGE = 'seo.metadata.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'audit.read',
  'reviews.review.read',
  'moderation.report.read',
  'support.ticket.read',
  'platform.job.read',
  'disputes.dispute.read',
  'cms.page.read',
  'cms.page.manage',
  // The other two SEO clusters: the redirect map, and the site-wide defaults this increment does not build.
  'seo.redirect.read',
  'seo.redirect.manage',
  'seo.settings.manage',
] as const;

const LIST_ROW = {
  entryId: ENTRY,
  entityType: 'category',
  entityId: CATEGORY,
  routePath: null,
  targetSlug: 'furniture',
  localeCode: 'en',
  metaTitle: 'Lovely furniture',
  metaDescription: 'Chairs and tables.',
  canonicalPath: null,
  robotsDirectives: ['index', 'follow'],
  ogTitle: null,
  ogDescription: null,
  shareMediaId: null,
  canonicalIsHonoured: false,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const DETAIL_ROW = {
  ...LIST_ROW,
  shareObjectPath: null,
  effectiveCanonicalPath: null,
  effectiveRobotsDirectives: [],
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedBy: STAFF,
  canManage: true,
};

const OVERRIDE = {
  metaTitle: 'Lovely furniture',
  metaDescription: 'Chairs and tables.',
  canonicalPath: null,
  robotsDirectives: ['nosnippet'],
  ogTitle: 'Lovely furniture',
  ogDescription: 'Chairs and tables.',
  shareObjectPath: 'cms-media/share/card.png',
};

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  listRows?: readonly Record<string, unknown>[];
  detailRow?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  overrideError?: boolean;
  writeError?: { code: string };
  writeResult?: boolean;
}

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error('the database refused it'), { code });
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const adminStore = {
    seoMetadataForStaff: async (input: { limit: number }) => {
      seen.push({ name: 'seoMetadataForStaff', input });
      return doubles.listRows ?? [LIST_ROW];
    },
    seoMetadataEntryForStaff: async (input: unknown) => {
      seen.push({ name: 'seoMetadataEntryForStaff', input });
      return doubles.detailRow === undefined ? DETAIL_ROW : doubles.detailRow;
    },
    seoMetadataSaveForStaff: async (input: unknown) => {
      seen.push({ name: 'seoMetadataSaveForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return ENTRY;
    },
    seoMetadataDeleteForStaff: async (input: unknown) => {
      seen.push({ name: 'seoMetadataDeleteForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.writeResult ?? true;
    },
  };

  const seoStore = {
    publicSeoMetadataForEntity: async (input: unknown) => {
      seen.push({ name: 'publicSeoMetadataForEntity', input });
      if (doubles.overrideError === true) throw new Error('the database is unreachable');
      return doubles.override === undefined ? OVERRIDE : doubles.override;
    },
    publicSeoMetadataForRoute: async (input: unknown) => {
      seen.push({ name: 'publicSeoMetadataForRoute', input });
      if (doubles.overrideError === true) throw new Error('the database is unreachable');
      return doubles.override === undefined ? OVERRIDE : doubles.override;
    },
    publicRedirectResolve: async () => null,
    publicRobotsBody: async () => null,
    publicSitemapCounts: async () => [],
    publicSitemapPages: async () => [],
    publicSitemapListings: async () => [],
    publicSitemapServices: async () => [],
    publicSitemapCategories: async () => [],
    publicSitemapSellers: async () => [],
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('writing metadata must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('writing metadata must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty. Both roles holding a metadata key require MFA.
        const granted = [...(doubles.permissions ?? [READ, MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(SEO_STORE)
    .useValue(seoStore)
    .overrideProvider(SEO_METADATA_STORE)
    .useValue(adminStore)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return seen;
}

function request(options: {
  method: string;
  url: string;
  accessToken?: string;
  payload?: unknown;
  credential?: string;
}) {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: options.credential ?? TEST_INTERNAL_CREDENTIAL,
  };
  if (options.accessToken !== undefined) headers[SESSION_TOKEN_HEADER] = options.accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({
    method: options.method as 'GET',
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* The public read                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/seo/metadata', () => {
  it('answers with no session at all, addressed by slug', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/seo/metadata?entityType=category&slug=furniture&locale=en',
    });
    expect(response.statusCode).toBe(200);
    const body = PublicSeoMetadataResponseSchema.parse(response.json());
    expect(body.override?.metaTitle).toBe('Lovely furniture');
    // Addressed by slug, which is the whole point: no identifier had to cross into a public response.
    expect(seen.find((entry) => entry.name === 'publicSeoMetadataForEntity')?.input).toEqual({
      entityType: 'category',
      slug: 'furniture',
      locale: 'en',
    });
  });

  it('answers for a fixed landing address by route path', async () => {
    const seen = await createApp();
    const response = await request({ method: 'GET', url: '/v1/seo/metadata?routePath=%2Flistings&locale=ar' });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'publicSeoMetadataForRoute')?.input).toEqual({
      routePath: '/listings',
      locale: 'ar',
    });
  });

  it('answers 200 with null when nothing is stored, never 404', async () => {
    await createApp({ override: null });
    const response = await request({ method: 'GET', url: '/v1/seo/metadata?entityType=listing&slug=a-chair' });
    expect(response.statusCode).toBe(200);
    expect(PublicSeoMetadataResponseSchema.parse(response.json())).toEqual({ override: null });
  });

  it('is a 503 when the override cannot be read, which is a different thing entirely', async () => {
    await createApp({ overrideError: true });
    const response = await request({ method: 'GET', url: '/v1/seo/metadata?entityType=listing&slug=a-chair' });
    expect(response.statusCode).toBe(503);
  });

  it('refuses a request that does not name exactly one kind of target', async () => {
    await createApp();
    for (const query of [
      '',
      'entityType=category',
      'slug=furniture',
      'entityType=category&slug=furniture&routePath=%2Flistings',
      'routePath=%2Flistings&slug=furniture',
      'routePath=not-a-path',
      'routePath=%2F%2Fevil.test',
      // A route is not addressed by slug: it has its own parameter.
      'entityType=route&slug=listings',
      // No blog page exists to read an override, so asking about one is malformed rather than empty.
      'entityType=blog_post&slug=a-post',
      'entityType=widget&slug=anything',
    ]) {
      const response = await request({ method: 'GET', url: `/v1/seo/metadata?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('defaults an unrecognised locale rather than failing', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/seo/metadata?entityType=listing&slug=a-chair&locale=xx' });
    await request({ method: 'GET', url: '/v1/seo/metadata?entityType=listing&slug=a-chair' });
    expect(
      seen
        .filter((entry) => entry.name === 'publicSeoMetadataForEntity')
        .map((entry) => (entry.input as { locale: string }).locale),
    ).toEqual(['en', 'en']);
  });

  it('does not act on a canonical the table could not have stored', async () => {
    for (const canonicalPath of ['https://evil.test/', '//evil.test', 'relative-but-not-a-path']) {
      await createApp({ override: { ...OVERRIDE, canonicalPath } });
      const response = await request({ method: 'GET', url: '/v1/seo/metadata?entityType=page&slug=about' });
      const body = PublicSeoMetadataResponseSchema.parse(response.json());
      // Dropped, not refused: the rest of the override is perfectly usable and a crawler-facing canonical nobody
      // authored is the one field worth discarding.
      expect(body.override?.canonicalPath, canonicalPath).toBeNull();
      expect(body.override?.metaTitle, canonicalPath).toBe('Lovely furniture');
      await app?.close();
      app = undefined;
    }
  });

  it('drops a permissive directive, because a stored value can never widen indexing', async () => {
    await createApp({ override: { ...OVERRIDE, robotsDirectives: ['index', 'follow', 'nosnippet', 'max-snippet:-1'] } });
    const response = await request({ method: 'GET', url: '/v1/seo/metadata?entityType=listing&slug=a-chair' });
    const body = PublicSeoMetadataResponseSchema.parse(response.json());
    expect(body.override?.robotsDirectives).toEqual(['nosnippet']);
  });

  it('still requires the internal BFF credential', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/seo/metadata?entityType=listing&slug=a-chair',
      credential: 'not-the-credential',
    });
    expect(response.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The admin list and detail                                                                         */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/seo/metadata', () => {
  it('returns one page of overrides to a holder of the read key', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/seo/metadata', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = SeoMetadataEntriesResponseSchema.parse(response.json());
    expect(body.items[0]?.targetSlug).toBe('furniture');
    // Stored as stored: an operator has to see their own work, even where the public will not receive it.
    expect(body.items[0]?.robotsDirectives).toEqual(['index', 'follow']);
    expect(body.items[0]?.canonicalIsHonoured).toBe(false);
  });

  it('asks for one row more than the page size, so the cursor is known rather than guessed', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/seo/metadata?limit=10', accessToken: ACCESS_TOKEN });
    expect((seen.find((entry) => entry.name === 'seoMetadataForStaff')?.input as { limit: number }).limit).toBe(11);
  });

  it('forwards both filters as text', async () => {
    const seen = await createApp();
    await request({
      method: 'GET',
      url: '/v1/admin/seo/metadata?entityType=listing&locale=ar',
      accessToken: ACCESS_TOKEN,
    });
    const call = seen.find((entry) => entry.name === 'seoMetadataForStaff')?.input as {
      entityType: string | null;
      locale: string | null;
    };
    expect(call.entityType).toBe('listing');
    expect(call.locale).toBe('ar');
  });

  it('accepts its own cursor and refuses every other list’s', async () => {
    await createApp();
    const mine = encodeSeoMetadataCursor({ updatedAt: new Date('2026-05-02T09:00:00.000Z'), id: ENTRY });
    const ok = await request({
      method: 'GET',
      url: `/v1/admin/seo/metadata?cursor=${encodeURIComponent(mine)}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(ok.statusCode).toBe(200);

    // The redirect map's position is a real position in the wrong list, and the two sit on the same section.
    const foreign = Buffer.from(`rd1|2026-05-02T09:00:00.000Z|${ENTRY}`, 'utf8').toString('base64url');
    const refused = await request({
      method: 'GET',
      url: `/v1/admin/seo/metadata?cursor=${encodeURIComponent(foreign)}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(refused.statusCode).toBe(400);
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({ method: 'GET', url: '/v1/admin/seo/metadata', accessToken: ACCESS_TOKEN });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }

    await createApp();
    const atAal1 = await request({ method: 'GET', url: '/v1/admin/seo/metadata', accessToken: AAL1_TOKEN });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session, and the internal credential as well', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/seo/metadata' })).statusCode).toBe(401);
    expect(
      (
        await request({
          method: 'GET',
          url: '/v1/admin/seo/metadata',
          accessToken: ACCESS_TOKEN,
          credential: 'not-the-credential',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('GET /v1/admin/seo/metadata/:entryId', () => {
  it('shows the stored value beside what the public would receive', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/metadata/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SeoMetadataDetailResponseSchema.parse(response.json());
    expect(body.entry.robotsDirectives).toEqual(['index', 'follow']);
    expect(body.entry.effectiveRobotsDirectives).toEqual([]);
    expect(body.entry.canManage).toBe(true);
  });

  it('reports canManage false for a caller holding only the read key', async () => {
    await createApp({ permissions: [READ], detailRow: { ...DETAIL_ROW, canManage: false } });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/metadata/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(SeoMetadataDetailResponseSchema.parse(response.json()).entry.canManage).toBe(false);
  });

  it('is a 404 for an entry that is not there, and a 400 for an identifier that is not one', async () => {
    await createApp({ detailRow: null });
    expect(
      (await request({ method: 'GET', url: `/v1/admin/seo/metadata/${ENTRY}`, accessToken: ACCESS_TOKEN })).statusCode,
    ).toBe(404);
    expect(
      (await request({ method: 'GET', url: '/v1/admin/seo/metadata/not-a-uuid', accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(400);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writing                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('PUT /v1/admin/seo/metadata', () => {
  it('writes an override and answers with its identifier', async () => {
    await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'category', entityId: CATEGORY, localeCode: 'en', metaTitle: 'Lovely furniture' },
    });
    expect(response.statusCode).toBe(200);
    expect(SaveSeoMetadataResponseSchema.parse(response.json()).id).toBe(ENTRY);
  });

  it('is a replace: a field left out is sent as nothing', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'category', entityId: CATEGORY, localeCode: 'en', metaTitle: 'Only a title' },
    });
    const call = seen.find((entry) => entry.name === 'seoMetadataSaveForStaff')?.input as Record<string, unknown>;
    expect(call['metaTitle']).toBe('Only a title');
    expect(call['metaDescription']).toBeNull();
    expect(call['canonicalPath']).toBeNull();
    expect(call['ogTitle']).toBeNull();
    // Absent directives mean 0030's own column default, which the writer applies — so null, not an empty array.
    expect(call['robotsDirectives']).toBeNull();
  });

  it('sends a route’s path and no identifier, and an entity’s identifier and no path', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'route', routePath: '/listings', localeCode: 'en' },
    });
    const route = seen.find((entry) => entry.name === 'seoMetadataSaveForStaff')?.input as Record<string, unknown>;
    expect(route['routePath']).toBe('/listings');
    expect(route['entityId']).toBeNull();
  });

  it('refuses a request the table could not store, without reaching the database', async () => {
    const seen = await createApp();
    for (const payload of [
      {},
      { entityType: 'category', localeCode: 'en' },
      { entityType: 'route', localeCode: 'en' },
      { entityType: 'route', routePath: '/x', entityId: CATEGORY, localeCode: 'en' },
      { entityType: 'blog_post', entityId: CATEGORY, localeCode: 'en' },
      { entityType: 'service', entityId: CATEGORY, localeCode: 'en' },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', canonicalPath: 'https://evil.test/' },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', robotsDirectives: ['index', 'noindex'] },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', robotsDirectives: [] },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', metaTitle: 't'.repeat(71) },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'eng' },
    ]) {
      const response = await request({
        method: 'PUT',
        url: '/v1/admin/seo/metadata',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'seoMetadataSaveForStaff')).toHaveLength(0);
  });

  it('accepts a canonical for a kind that will not read it, because storing is not reading', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'listing', entityId: CATEGORY, localeCode: 'en', canonicalPath: '/elsewhere' },
    });
    expect(response.statusCode).toBe(200);
    const call = seen.find((entry) => entry.name === 'seoMetadataSaveForStaff')?.input as Record<string, unknown>;
    // Stored, and withheld from the public by the reader. Refusing it here would hide from an operator that the
    // value is kept, and 0030 keeps it.
    expect(call['canonicalPath']).toBe('/elsewhere');
  });

  it('carries no structured data and no actor, whatever a browser sends', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: {
        entityType: 'category',
        entityId: CATEGORY,
        localeCode: 'en',
        structuredData: { '@type': 'Product' },
        updatedBy: '99999999-9999-4999-8999-999999999999',
        isAal2: true,
      },
    });
    const call = seen.find((entry) => entry.name === 'seoMetadataSaveForStaff')?.input as Record<string, unknown>;
    expect('structuredData' in call).toBe(false);
    // The account and the assurance level reach the database, but from the session rather than from the body.
    expect(call['userId']).toBe(STAFF);
    expect(call['isAal2']).toBe(true);
  });

  it('turns each refusal the database can raise into its own code', async () => {
    const cases = [
      { sqlstate: '23514', status: 409, code: 'SEO_METADATA_NOT_ALLOWED' },
      { sqlstate: '23503', status: 409, code: 'SEO_METADATA_TARGET_UNKNOWN' },
      // The database refusing a caller without the manage key. A 404, not a 403.
      { sqlstate: '42501', status: 404, code: 'NOT_FOUND' },
      { sqlstate: '23502', status: 503, code: 'SERVICE_UNAVAILABLE' },
      { sqlstate: '08006', status: 503, code: 'SERVICE_UNAVAILABLE' },
    ] as const;

    for (const scenario of cases) {
      await createApp({ writeError: { code: scenario.sqlstate } });
      const response = await request({
        method: 'PUT',
        url: '/v1/admin/seo/metadata',
        accessToken: ACCESS_TOKEN,
        payload: { entityType: 'category', entityId: CATEGORY, localeCode: 'en' },
      });
      expect(response.statusCode, scenario.sqlstate).toBe(scenario.status);
      expect((response.json() as { code: string }).code, scenario.sqlstate).toBe(scenario.code);
      await app?.close();
      app = undefined;
    }
  });

  it('is a 404 for a caller holding only the read key', async () => {
    await createApp({ permissions: [READ], writeError: { code: '42501' } });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'category', entityId: CATEGORY, localeCode: 'en' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /v1/admin/seo/metadata/:entryId', () => {
  it('removes an override', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/seo/metadata/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(SeoMetadataWriteResponseSchema.parse(response.json()).ok).toBe(true);
    expect(seen.filter((entry) => entry.name === 'seoMetadataDeleteForStaff')).toHaveLength(1);
  });

  it('is a 404 when the override is not there, or the caller may only read', async () => {
    await createApp({ writeResult: false });
    expect(
      (await request({ method: 'DELETE', url: `/v1/admin/seo/metadata/${ENTRY}`, accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(404);
    await app?.close();
    app = undefined;

    await createApp({ permissions: [READ], writeError: { code: '42501' } });
    expect(
      (await request({ method: 'DELETE', url: `/v1/admin/seo/metadata/${ENTRY}`, accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(404);
  });

  it('needs a session', async () => {
    await createApp();
    expect((await request({ method: 'DELETE', url: `/v1/admin/seo/metadata/${ENTRY}` })).statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What this surface does not have                                                                   */
/* ------------------------------------------------------------------------------------------------ */

describe('the shape of this surface', () => {
  it('has no route of its own for the site-wide defaults, which are a separate cluster', async () => {
    // 0096 gave `/v1/admin/seo/settings` a controller of its own behind its own key, `seo.settings.manage`, which
    // this suite's caller does not hold — so that address answers the same neutral 404 here as the two that do not
    // exist at all. The point of this test is unchanged: *this* surface serves none of them.
    await createApp();
    for (const url of ['/v1/admin/seo/settings', '/v1/admin/seo/metadata/defaults', '/v1/seo/settings']) {
      const response = await request({ method: 'GET', url, accessToken: ACCESS_TOKEN });
      // `/metadata/defaults` is caught by `/{entryId}` as a malformed identifier; what matters is that nothing
      // answers 200.
      expect([400, 403, 404], url).toContain(response.statusCode);
    }
  });

  it('has no POST on the collection: writing is a replace and says so', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/seo/metadata',
      accessToken: ACCESS_TOKEN,
      payload: { entityType: 'category', entityId: CATEGORY, localeCode: 'en' },
    });
    expect(response.statusCode).toBe(404);
  });
});
