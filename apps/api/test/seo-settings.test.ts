import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  SESSION_TOKEN_HEADER,
  SeoSettingsResponseSchema,
  SeoSettingsWriteResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SEO_SETTINGS_STORE } from '../src/admin/seo-settings.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The site-wide SEO settings at the API boundary (0096).
 *
 * The properties this suite exists for:
 *
 * **One key gates everything.** `seo.settings.manage` opens the section and authorises every write; there is no
 * `seo.settings.read` and none is accepted as a substitute. A caller holding every other console key in the platform
 * reads nothing here, and `canManage` is true for anyone who gets an answer, because on a one-key surface there is no
 * second capability to report.
 *
 * **Every locale comes back, authored or not**, so the first save has somewhere to happen — and `robotsIsServed`
 * crosses the boundary as the database answered it, never recomputed from `isDefaultLocale` on the way out.
 *
 * **A save is a replace.** An omitted optional field reaches the store as `null`, which is what makes "the form is
 * the row" true all the way down; `isPublished`-style surprises are impossible because there is no state field here
 * at all.
 *
 * **A robots body crosses exactly as sent**, interior newlines included, because it is served to crawlers verbatim
 * and nothing in this layer may normalise it.
 *
 * **Nothing about a locale is decided here.** A locale that is not an active locale is the store's `false`, which
 * becomes a 404 identical to an absence; a locale code that is not a locale code is a 400 before any read.
 *
 * **The 0030 refusals are reported, not invented**: `23514` becomes `SEO_SETTINGS_NOT_ALLOWED` and `23503` becomes
 * `SEO_SETTINGS_MEDIA_MISSING`, each a 409, and `42501` becomes the 404.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const MEDIA = 'ee000000-0000-4000-8000-0000000000a1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const MANAGE = 'seo.settings.manage';

/**
 * Every other key a console surface uses, including the two other `seo` ones and an invented read key.
 *
 * `seo.settings.read` is in this list on purpose: it does not exist in the seed, it is not accepted here, and a test
 * that passes it must still read nothing — so an invented key can never quietly become a way in.
 */
const OTHER_KEYS = [
  'seo.settings.read',
  'seo.metadata.read',
  'seo.metadata.manage',
  'seo.redirect.read',
  'seo.redirect.manage',
  'cms.page.read',
  'cms.homepage.read',
  'cms.navigation.read',
  'cms.faq.read',
  'settings.site.read',
  'settings.site.manage',
  'audit.read',
  'users.role.manage',
] as const;

/** A crawl policy with an interior blank line, so normalisation anywhere would be visible. */
const ROBOTS = 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /';

const EN_ROW = {
  localeCode: 'en',
  localeNameEn: 'English',
  localeNameNative: 'English',
  isDefaultLocale: true,
  isAuthored: true,
  robotsIsServed: true,
  siteName: 'Egypt Market',
  defaultMetaTitle: 'Buy and sell in Egypt',
  defaultMetaDescription: 'Everything for sale, in one place.',
  defaultShareMediaId: MEDIA,
  shareMediaObjectPath: 'cms-media/share/default.png',
  twitterSite: '@egyptmarket',
  robotsTxtBody: ROBOTS,
  organizationStructuredData: { name: 'Egypt Market' },
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const AR_ROW = {
  localeCode: 'ar',
  localeNameEn: 'Arabic',
  localeNameNative: 'العربية',
  isDefaultLocale: false,
  isAuthored: false,
  robotsIsServed: false,
  siteName: null,
  defaultMetaTitle: null,
  defaultMetaDescription: null,
  defaultShareMediaId: null,
  shareMediaObjectPath: null,
  twitterSite: null,
  robotsTxtBody: null,
  organizationStructuredData: null,
  updatedAt: null,
};

interface Seen {
  name: string;
  input: unknown;
}

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  rows?: readonly unknown[];
  readError?: boolean;
  writeResult?: boolean;
  writeError?: { code: string };
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  const error = new Error('the database refused the write') as Error & { code: string };
  error.code = code;
  return error;
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const store = {
    seoSettingsForStaff: async (input: unknown) => {
      seen.push({ name: 'seoSettingsForStaff', input });
      if (doubles.readError === true) throw new Error('the database is unavailable');
      return doubles.rows ?? [EN_ROW, AR_ROW];
    },
    seoSettingsSaveForStaff: async (input: unknown) => write('seoSettingsSaveForStaff', input),
    seoSettingsDeleteForStaff: async (input: unknown) => write('seoSettingsDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the SEO settings must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the SEO settings must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty.
        const granted = [...(doubles.permissions ?? [MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(SEO_SETTINGS_STORE)
    .useValue(store)
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

/** The one required field, so a test can say what it is actually about. */
const MINIMAL = { siteName: 'Egypt Market' } as const;

/* ------------------------------------------------------------------------------------------------ */
/* Reading                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/seo/settings', () => {
  it('returns one row per locale, authored or not', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = SeoSettingsResponseSchema.parse(response.json());
    expect(body.locales.map((locale) => locale.localeCode)).toEqual(['en', 'ar']);
    expect(body.locales[0]?.isAuthored).toBe(true);
    // The unauthored locale is a row with nulls, which is what makes the first save possible.
    expect(body.locales[1]?.isAuthored).toBe(false);
    expect(body.locales[1]?.siteName).toBeNull();
  });

  it('reports canManage as true, because one key opens and authorises this surface', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    expect(SeoSettingsResponseSchema.parse(response.json()).canManage).toBe(true);
  });

  it('carries the robots body exactly as stored, interior blank line and all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    expect(SeoSettingsResponseSchema.parse(response.json()).locales[0]?.robotsTxtBody).toBe(ROBOTS);
  });

  it('carries robotsIsServed as the database answered it and recomputes nothing', async () => {
    // Deliberately contradictory rows: a default locale that is not served, and a non-default one that is. The
    // database owns this answer, so a boundary that recomputed it from isDefaultLocale would be caught here.
    await createApp({
      rows: [
        { ...EN_ROW, isDefaultLocale: true, robotsIsServed: false },
        { ...AR_ROW, isDefaultLocale: false, robotsIsServed: true },
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    const body = SeoSettingsResponseSchema.parse(response.json());
    expect(body.locales[0]?.robotsIsServed).toBe(false);
    expect(body.locales[1]?.robotsIsServed).toBe(true);
  });

  it('reports the share image as an identifier and a path, and never as an address', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    const locale = SeoSettingsResponseSchema.parse(response.json()).locales[0];
    expect(locale?.defaultShareMediaId).toBe(MEDIA);
    expect(locale?.shareMediaObjectPath).toBe('cms-media/share/default.png');
    expect(JSON.stringify(locale)).not.toContain('http');
  });

  it('passes the caller and the assurance level to the reader and nothing else', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/seo/settings', accessToken: ACCESS_TOKEN });
    expect(seen.filter((entry) => entry.name === 'seoSettingsForStaff')).toHaveLength(1);
    expect(seen.find((entry) => entry.name === 'seoSettingsForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
    });
  });

  it('needs a session', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/seo/settings' })).statusCode).toBe(401);
  });

  it('needs the internal credential', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/settings',
      accessToken: ACCESS_TOKEN,
      credential: 'not-the-credential',
    });
    expect(response.statusCode).toBe(403);
  });

  it('is a 404 at aal1, because the roles that hold the key require MFA', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/settings',
      accessToken: AAL1_TOKEN,
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'seoSettingsForStaff')).toBe(false);
  });

  it('is a 404 for a caller holding every other console key, invented read key included', async () => {
    const seen = await createApp({ permissions: OTHER_KEYS });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/settings',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
    // Not one read reached the store: the absence is decided before anything is asked.
    expect(seen.some((entry) => entry.name === 'seoSettingsForStaff')).toBe(false);
  });

  it('is a 503 when the settings cannot be read', async () => {
    await createApp({ readError: true });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/settings',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writing                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('PUT /v1/admin/seo/settings/{localeCode}', () => {
  it('writes one locale and answers ok', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: {
        siteName: 'Egypt Market',
        defaultMetaTitle: 'Buy and sell in Egypt',
        defaultMetaDescription: 'Everything for sale, in one place.',
        defaultShareMediaId: MEDIA,
        twitterSite: '@egyptmarket',
        robotsTxtBody: ROBOTS,
        organizationStructuredData: { name: 'Egypt Market' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(SeoSettingsWriteResponseSchema.parse(response.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'seoSettingsSaveForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      localeCode: 'en',
      siteName: 'Egypt Market',
      defaultMetaTitle: 'Buy and sell in Egypt',
      defaultMetaDescription: 'Everything for sale, in one place.',
      defaultShareMediaId: MEDIA,
      twitterSite: '@egyptmarket',
      robotsTxtBody: ROBOTS,
      organizationStructuredData: { name: 'Egypt Market' },
    });
  });

  it('sends every omitted field to the store as null, because a save is a replace', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(seen.find((entry) => entry.name === 'seoSettingsSaveForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      localeCode: 'en',
      siteName: 'Egypt Market',
      defaultMetaTitle: null,
      defaultMetaDescription: null,
      defaultShareMediaId: null,
      twitterSite: null,
      robotsTxtBody: null,
      organizationStructuredData: null,
    });
  });

  it('carries a robots body to the store exactly as sent', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: { ...MINIMAL, robotsTxtBody: ROBOTS },
    });
    const input = seen.find((entry) => entry.name === 'seoSettingsSaveForStaff')?.input as {
      robotsTxtBody: string;
    };
    expect(input.robotsTxtBody).toBe(ROBOTS);
  });

  it('writes the non-default locale too, because storing one is allowed', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/ar',
      accessToken: ACCESS_TOKEN,
      payload: { ...MINIMAL, robotsTxtBody: 'User-agent: *\nDisallow: /' },
    });
    expect(response.statusCode).toBe(200);
    expect((seen.find((entry) => entry.name === 'seoSettingsSaveForStaff')?.input as { localeCode: string })
      .localeCode).toBe('ar');
  });

  it('needs a site name', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: { defaultMetaTitle: 'A title with no site name' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('refuses a field the contract does not name', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: { ...MINIMAL, updatedBy: STAFF },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('refuses a locale code that is not a locale code, before any write', async () => {
    const seen = await createApp();
    for (const locale of ['english', 'e', 'EN', 'en_GB', 'en-gb', 'en%2Fx']) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/seo/settings/${locale}`,
        accessToken: ACCESS_TOKEN,
        payload: MINIMAL,
      });
      expect(response.statusCode, locale).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('never routes a traversal attempt to this controller at all', async () => {
    // `../en` is normalised by the router before any handler is chosen, so it matches no route and is a 404 rather
    // than this controller's 400. Asserted separately because the two outcomes mean different things: one is a value
    // this controller refused, the other is an address that never reached it.
    const seen = await createApp();
    for (const locale of ['../en', '..%2Fen', 'en/../../metadata']) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/seo/settings/${locale}`,
        accessToken: ACCESS_TOKEN,
        payload: MINIMAL,
      });
      expect([400, 404], locale).toContain(response.statusCode);
    }
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('refuses the lengths and the handle format the schema restates', async () => {
    const seen = await createApp();
    const bad: readonly Record<string, unknown>[] = [
      { siteName: '' },
      { siteName: '   ' },
      { siteName: 'n'.repeat(121) },
      { ...MINIMAL, defaultMetaTitle: 't'.repeat(71) },
      { ...MINIMAL, defaultMetaDescription: 'd'.repeat(321) },
      { ...MINIMAL, twitterSite: 'egyptmarket' },
      { ...MINIMAL, twitterSite: '@way-too-long-for-a-handle' },
      { ...MINIMAL, defaultShareMediaId: 'not-a-uuid' },
      { ...MINIMAL, organizationStructuredData: [] },
      { ...MINIMAL, organizationStructuredData: 'a string' },
    ];
    for (const payload of bad) {
      const response = await request({
        method: 'PUT',
        url: '/v1/admin/seo/settings/en',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('is a 404 when the locale is not an active locale', async () => {
    // The store's own false, which is a thing about the platform's state and is reported as an absence.
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/fr',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(404);
  });

  it('turns a refused value into a 409 with our own code', async () => {
    await createApp({ writeError: { code: '23514' } });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('SEO_SETTINGS_NOT_ALLOWED');
  });

  it('turns a share image that does not exist into its own 409', async () => {
    await createApp({ writeError: { code: '23503' } });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: { ...MINIMAL, defaultShareMediaId: MEDIA },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('SEO_SETTINGS_MEDIA_MISSING');
  });

  it('turns the database refusing the caller into a 404, not a 403', async () => {
    await createApp({ writeError: { code: '42501' } });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 503 when the write fails for another reason', async () => {
    await createApp({ writeError: { code: '08006' } });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(503);
  });

  it('is a 404 for a caller without the key, and writes nothing', async () => {
    const seen = await createApp({ permissions: OTHER_KEYS });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('is a 404 at aal1', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      accessToken: AAL1_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'seoSettingsSaveForStaff')).toBe(false);
  });

  it('needs a session', async () => {
    await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/seo/settings/en',
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Deleting                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

describe('DELETE /v1/admin/seo/settings/{localeCode}', () => {
  it('removes one locale and answers ok', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(SeoSettingsWriteResponseSchema.parse(response.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'seoSettingsDeleteForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      localeCode: 'en',
    });
  });

  it('is a 404 when nothing was authored for that locale', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'DELETE',
      url: '/v1/admin/seo/settings/ar',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a locale code that is not a locale code', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: '/v1/admin/seo/settings/english',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'seoSettingsDeleteForStaff')).toBe(false);
  });

  it('turns the database refusing the caller into a 404', async () => {
    await createApp({ writeError: { code: '42501' } });
    const response = await request({
      method: 'DELETE',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 for a caller without the key, and deletes nothing', async () => {
    const seen = await createApp({ permissions: OTHER_KEYS });
    const response = await request({
      method: 'DELETE',
      url: '/v1/admin/seo/settings/en',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'seoSettingsDeleteForStaff')).toBe(false);
  });

  it('needs a session', async () => {
    await createApp();
    expect((await request({ method: 'DELETE', url: '/v1/admin/seo/settings/en' })).statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What this surface does not have                                                                   */
/* ------------------------------------------------------------------------------------------------ */

describe('the shape of this surface', () => {
  it('has no public route: nothing here is served to anybody', async () => {
    // Owner decisions 1-4. `/v1/seo/robots` is 0086's and is a different controller entirely; these four addresses
    // are the ones a consuming increment would add, and none of them exists.
    await createApp();
    for (const url of ['/v1/seo/settings', '/v1/seo/site-name', '/v1/seo/defaults', '/v1/seo/organization']) {
      const response = await request({ method: 'GET', url, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('has no POST on the collection: writing is a replace and says so', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/seo/settings',
      accessToken: ACCESS_TOKEN,
      payload: MINIMAL,
    });
    expect(response.statusCode).toBe(404);
  });

  it('has no route that could change which locale is served', async () => {
    await createApp();
    for (const url of ['/v1/admin/seo/settings/default', '/v1/admin/seo/settings/en/default']) {
      const response = await request({
        method: 'PUT',
        url,
        accessToken: ACCESS_TOKEN,
        payload: { isDefault: true },
      });
      // `/default` is caught by `:localeCode` as a malformed locale; what matters is that nothing answers 200.
      expect([400, 404], url).toContain(response.statusCode);
    }
  });
});
