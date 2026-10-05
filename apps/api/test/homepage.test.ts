import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateHomepageSectionResponseSchema,
  HomepageSectionDetailResponseSchema,
  HomepageSectionsResponseSchema,
  HomepageWriteResponseSchema,
  PublicHomepageResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { HOMEPAGE_STORE } from '../src/admin/homepage.service.js';
import { HOMEPAGE_PUBLIC_STORE } from '../src/cms/homepage-public.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The homepage at the API boundary (0093).
 *
 * The properties this suite exists for:
 *
 * **A section with nothing left to show never reaches a browser.** Owner decision C, asserted from both ends: a
 * curated section whose rows have all gone is absent from the response, and the staff detail reports the counts
 * that explain why.
 *
 * **A malformed stored document costs one section, not the homepage.** The store returns a `featured_listings`
 * carrying a count, and the rest of the homepage still renders.
 *
 * **Nothing reads a promotion, a placement or a ranking.** Owner decision A, asserted by what the service asks
 * the store for: the store double records every call and the inventory is closed.
 *
 * **`banner_strip` cannot be created and is never served.** Both asserted directly.
 *
 * **Reading and managing are separate keys**, and the split is visible: a caller with only `cms.homepage.read`
 * lists the sections, gets `canManage: false`, and every write answers 404 — identical to a section that does not
 * exist.
 *
 * **Editing a section cannot show it.** `PATCH` is driven with `isActive` in the body and the store is asserted
 * never to have been asked to change a state.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const SECTION = 'fc000000-0000-4000-8000-0000000000e1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'cms.homepage.read';
const MANAGE = 'cms.homepage.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'audit.read',
  'moderation.report.read',
  'support.ticket.read',
  'cms.page.read',
  'cms.blog.read',
  'cms.banner.read',
  'cms.navigation.read',
  'seo.metadata.read',
] as const;

const LISTING_ROW = {
  resultType: 'listing',
  slug: 'a-chair',
  title: 'A chair',
  city: 'Cairo',
  priceMinor: '10000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: true,
};

const POST_ROW = {
  slug: 'a-lovely-post',
  resolvedLocale: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  categorySlug: 'news',
  categoryName: 'News',
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
};

const SECTION_ROW = {
  sectionId: SECTION,
  sectionKey: 'home_picks',
  sectionType: 'featured_listings',
  titleEn: 'Our picks',
  titleAr: null,
  subtitleEn: null,
  subtitleAr: null,
  config: { ids: ['22222222-2222-4222-8222-222222222222'] },
  sortOrder: 20,
  isActive: true,
  isServed: true,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const DETAIL_ROW = {
  ...SECTION_ROW,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  canManage: true,
  chosenCount: 4,
  renderableCount: 2,
};

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  /** What the public section reader answers with. */
  publicSections?: readonly Record<string, unknown>[];
  listings?: readonly Record<string, unknown>[];
  categories?: readonly Record<string, unknown>[];
  sellers?: readonly Record<string, unknown>[];
  posts?: readonly Record<string, unknown>[];
  listRows?: readonly Record<string, unknown>[];
  detailRow?: Record<string, unknown> | null;
  writeError?: { code: string };
  writeResult?: boolean;
  saveId?: string | null;
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

  const publicStore = {
    publicHomepageSections: async (input: unknown) => {
      seen.push({ name: 'publicHomepageSections', input });
      return (
        doubles.publicSections ?? [
          {
            sectionId: SECTION,
            sectionKey: 'home_picks',
            sectionType: 'featured_listings',
            title: 'Our picks',
            subtitle: null,
            sortOrder: 20,
            config: { ids: ['22222222-2222-4222-8222-222222222222'] },
          },
        ]
      );
    },
    publicHomepageListings: async (input: unknown) => {
      seen.push({ name: 'publicHomepageListings', input });
      return doubles.listings ?? [LISTING_ROW];
    },
    publicHomepageLatestListings: async (input: unknown) => {
      seen.push({ name: 'publicHomepageLatestListings', input });
      return doubles.listings ?? [LISTING_ROW];
    },
    publicHomepageCategories: async (input: unknown) => {
      seen.push({ name: 'publicHomepageCategories', input });
      return doubles.categories ?? [{ slug: 'furniture', name: 'Furniture', listingTypeCode: null, icon: 'sofa' }];
    },
    publicHomepageSellers: async (input: unknown) => {
      seen.push({ name: 'publicHomepageSellers', input });
      return doubles.sellers ?? [{ slug: 'good-shop', displayName: 'Good Shop', city: 'Cairo', bio: null }];
    },
    publicHomepagePosts: async (input: unknown) => {
      seen.push({ name: 'publicHomepagePosts', input });
      return doubles.posts ?? [POST_ROW];
    },
  };

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const adminStore = {
    homepageSectionsForStaff: async (input: unknown) => {
      seen.push({ name: 'homepageSectionsForStaff', input });
      return doubles.listRows ?? [SECTION_ROW];
    },
    homepageSectionForStaff: async (input: unknown) => {
      seen.push({ name: 'homepageSectionForStaff', input });
      return doubles.detailRow === undefined ? DETAIL_ROW : doubles.detailRow;
    },
    homepageSectionSaveForStaff: async (input: unknown) => {
      seen.push({ name: 'homepageSectionSaveForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.saveId === undefined ? SECTION : doubles.saveId;
    },
    homepageSectionStateForStaff: async (input: unknown) => write('homepageSectionStateForStaff', input),
    homepageSectionsReorderForStaff: async (input: unknown) => {
      seen.push({ name: 'homepageSectionsReorderForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return 1;
    },
    homepageSectionDeleteForStaff: async (input: unknown) => write('homepageSectionDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the homepage must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the homepage must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty.
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
    .overrideProvider(HOMEPAGE_PUBLIC_STORE)
    .useValue(publicStore)
    .overrideProvider(HOMEPAGE_STORE)
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

/** One section of each kind, as the public reader would return it. */
function sectionRow(sectionType: string, config: unknown, key = `home_${sectionType}`) {
  return { sectionId: SECTION, sectionKey: key, sectionType, title: 'A title', subtitle: null, sortOrder: 10, config };
}

/* ------------------------------------------------------------------------------------------------ */
/* The public homepage                                                                               */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/homepage', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    expect(response.statusCode).toBe(200);
    const body = PublicHomepageResponseSchema.parse(response.json());
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]?.sectionType).toBe('featured_listings');
  });

  it('is a 200 with no sections for a homepage nobody has composed', async () => {
    await createApp({ publicSections: [] });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    // A 404 here would turn a fresh install into a broken site.
    expect(response.statusCode).toBe(200);
    expect(PublicHomepageResponseSchema.parse(response.json()).sections).toEqual([]);
  });

  it('resolves every served section type', async () => {
    await createApp({
      publicSections: [
        sectionRow('hero', { lead: 'Find what you need.', ctaLabel: 'Browse', ctaPath: '/listings' }),
        sectionRow('featured_listings', { ids: ['22222222-2222-4222-8222-222222222222'] }),
        sectionRow('latest_listings', { count: 4 }),
        sectionRow('featured_categories', { ids: ['22222222-2222-4222-8222-222222222222'] }),
        sectionRow('featured_sellers', { ids: ['22222222-2222-4222-8222-222222222222'] }),
        sectionRow('blog_highlights', { count: 2 }),
        sectionRow('value_props', { items: [{ titleEn: 'Safe', bodyEn: 'We check sellers.' }] }),
        sectionRow('rich_text', { bodyEn: 'Some prose.' }),
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    const body = PublicHomepageResponseSchema.parse(response.json());
    expect(body.sections.map((section) => section.sectionType)).toEqual([
      'hero',
      'featured_listings',
      'latest_listings',
      'featured_categories',
      'featured_sellers',
      'blog_highlights',
      'value_props',
      'rich_text',
    ]);
  });

  it('serves a listing with no amount as a null price, never as a zero', async () => {
    // `listings.price_minor` is nullable, and a service priced on request is the ordinary case rather than an edge
    // one. Substituting a zero here would advertise a free item on the most visible page of the site.
    await createApp({
      publicSections: [sectionRow('featured_listings', { ids: ['22222222-2222-4222-8222-222222222222'] })],
      listings: [{ ...LISTING_ROW, resultType: 'service', priceMinor: null, isNegotiable: null }],
    });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    const body = PublicHomepageResponseSchema.parse(response.json());
    const section = body.sections[0];
    expect(section?.sectionType === 'featured_listings' && section.listings[0]).toEqual({
      resultType: 'service',
      slug: 'a-chair',
      title: 'A chair',
      city: 'Cairo',
      priceMinor: null,
      currencyCode: 'EGP',
      currencyMinorUnit: 2,
      isNegotiable: null,
    });
  });

  it('keeps an amount exact and in text, whatever the driver handed it over as', async () => {
    // A minor amount is an integer that must never pass through a float. A driver that returns a bigint column as a
    // JavaScript number is the case this guards: the response must still carry the digits.
    await createApp({
      publicSections: [sectionRow('featured_listings', { ids: ['22222222-2222-4222-8222-222222222222'] })],
      listings: [{ ...LISTING_ROW, priceMinor: 90071992547409 }],
    });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    const body = PublicHomepageResponseSchema.parse(response.json());
    const section = body.sections[0];
    expect(section?.sectionType === 'featured_listings' && section.listings[0]?.priceMinor).toBe('90071992547409');
  });

  it('skips a section whose content has all disappeared', async () => {
    // Owner decision C. The curated section names rows and the resolver returns none of them.
    await createApp({
      publicSections: [
        sectionRow('featured_listings', { ids: ['22222222-2222-4222-8222-222222222222'] }, 'home_gone'),
        sectionRow('rich_text', { bodyEn: 'Still here.' }, 'home_text'),
      ],
      listings: [],
    });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    const body = PublicHomepageResponseSchema.parse(response.json());
    expect(body.sections.map((section) => section.sectionKey)).toEqual(['home_text']);
  });

  it('skips an empty curated section without asking the database about it', async () => {
    const seen = await createApp({ publicSections: [sectionRow('featured_listings', { ids: [] })] });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    expect(PublicHomepageResponseSchema.parse(response.json()).sections).toEqual([]);
    // Nothing to resolve, so no round trip: a section that names no rows cannot show any.
    expect(seen.some((call) => call.name === 'publicHomepageListings')).toBe(false);
  });

  it('loses one malformed section rather than the whole homepage', async () => {
    await createApp({
      publicSections: [
        // A count on a curated section: a shape its type does not accept.
        sectionRow('featured_listings', { count: 4 }, 'home_broken'),
        sectionRow('rich_text', { bodyEn: 'Still here.' }, 'home_text'),
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    expect(response.statusCode).toBe(200);
    const body = PublicHomepageResponseSchema.parse(response.json());
    expect(body.sections.map((section) => section.sectionKey)).toEqual(['home_text']);
  });

  it('never serves a banner_strip, however the reader answers', async () => {
    await createApp({ publicSections: [sectionRow('banner_strip', {}), sectionRow('rich_text', { bodyEn: 'x' })] });
    const response = await request({ method: 'GET', url: '/v1/homepage' });
    const body = PublicHomepageResponseSchema.parse(response.json());
    expect(body.sections.map((section) => section.sectionType)).toEqual(['rich_text']);
  });

  it('asks the database for nothing but sections and the content they name', async () => {
    // Owner decision A, asserted as a closed inventory of calls: no promotion, no placement, no ranking.
    const seen = await createApp({
      publicSections: [
        sectionRow('featured_listings', { ids: ['22222222-2222-4222-8222-222222222222'] }),
        sectionRow('latest_listings', { count: 4 }),
        sectionRow('blog_highlights', { count: 2 }),
      ],
    });
    await request({ method: 'GET', url: '/v1/homepage' });
    expect([...new Set(seen.map((call) => call.name))].sort()).toEqual([
      'publicHomepageLatestListings',
      'publicHomepageListings',
      'publicHomepagePosts',
      'publicHomepageSections',
    ]);
  });

  it('passes the locale through and defaults an unrecognised one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/homepage?locale=ar' });
    expect(seen[0]?.input).toBe('ar');

    await request({ method: 'GET', url: '/v1/homepage?locale=fr' });
    expect(seen.at(-2)?.input ?? seen.at(-1)?.input).toBe('en');
  });

  it('prefers the Arabic wording where one was written', async () => {
    await createApp({
      publicSections: [
        sectionRow('rich_text', { bodyEn: 'English prose.', bodyAr: 'نص عربي.' }),
        sectionRow('value_props', {
          items: [{ titleEn: 'Safe', titleAr: 'آمن', bodyEn: 'We check sellers.', bodyAr: 'نتحقق من البائعين.' }],
        }, 'home_props'),
      ],
    });
    const body = PublicHomepageResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/homepage?locale=ar' })).json(),
    );
    const text = body.sections.find((section) => section.sectionType === 'rich_text');
    expect(text?.sectionType === 'rich_text' && text.body).toBe('نص عربي.');
    const props = body.sections.find((section) => section.sectionType === 'value_props');
    expect(props?.sectionType === 'value_props' && props.items[0]?.title).toBe('آمن');
  });

  it('falls back to the English wording where no Arabic one was written', async () => {
    await createApp({ publicSections: [sectionRow('rich_text', { bodyEn: 'English prose.' })] });
    const body = PublicHomepageResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/homepage?locale=ar' })).json(),
    );
    const text = body.sections.find((section) => section.sectionType === 'rich_text');
    expect(text?.sectionType === 'rich_text' && text.body).toBe('English prose.');
  });

  it('is a 503 when the homepage could not be read, rather than an empty one', async () => {
    // The one case a `Doubles` flag cannot express, because it is the reader itself failing: one app, built with a
    // store that throws, which is what an outage looks like from here.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
      .overrideProvider(SUPABASE_AUTH_CLIENT)
      .useValue({
        getUser: async () => ({ id: STAFF, phone: null }),
        signInWithPassword: async () => {
          throw new Error('reading the homepage must never sign anyone in');
        },
        revokeAllSessions: async () => {
          throw new Error('reading the homepage must never revoke a session');
        },
      })
      .overrideProvider(HOMEPAGE_PUBLIC_STORE)
      .useValue({
        publicHomepageSections: async () => {
          throw new Error('the database is unreachable');
        },
        publicHomepageListings: async () => [],
        publicHomepageLatestListings: async () => [],
        publicHomepageCategories: async () => [],
        publicHomepageSellers: async () => [],
        publicHomepagePosts: async () => [],
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
      NEST_APP_OPTIONS,
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await request({ method: 'GET', url: '/v1/homepage' });
    // Showing a visitor a blank front page when the truth is that we could not read it would be a wrong answer.
    expect(response.statusCode).toBe(503);
  });

  it('refuses a caller without the internal credential', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/homepage', credential: 'wrong' });
    expect(response.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The staff surface                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/homepage/sections', () => {
  it('lists for a caller holding the read key, and reports the manage capability', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/homepage/sections',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = HomepageSectionsResponseSchema.parse(response.json());
    expect(body.sections[0]?.sectionKey).toBe('home_picks');
    expect(body.canManage).toBe(false);
  });

  it('reports a misconfigured section, which only this layer can see', async () => {
    await createApp({ listRows: [{ ...SECTION_ROW, config: { count: 4 } }] });
    const body = HomepageSectionsResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/admin/homepage/sections', accessToken: ACCESS_TOKEN })).json(),
    );
    // The database has no opinion about what a type's document should hold, so the console has to be told.
    expect(body.sections[0]?.isConfigured).toBe(false);
  });

  it('lists a stored banner_strip and marks it as one the homepage will not render', async () => {
    await createApp({
      listRows: [{ ...SECTION_ROW, sectionType: 'banner_strip', sectionKey: 'home_strip', isServed: false }],
    });
    const body = HomepageSectionsResponseSchema.parse(
      (await request({ method: 'GET', url: '/v1/admin/homepage/sections', accessToken: ACCESS_TOKEN })).json(),
    );
    expect(body.sections[0]?.isServed).toBe(false);
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({
        method: 'GET',
        url: '/v1/admin/homepage/sections',
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }
    await createApp();
    const atAal1 = await request({
      method: 'GET',
      url: '/v1/admin/homepage/sections',
      accessToken: AAL1_TOKEN,
    });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session at all', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/homepage/sections' })).statusCode).toBe(401);
  });
});

describe('GET /v1/admin/homepage/sections/:sectionId', () => {
  it('reports how much of a section is still renderable', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = HomepageSectionDetailResponseSchema.parse(response.json());
    // Owner decision C made explainable: four chosen, two of them still visible.
    expect(body.section.chosenCount).toBe(4);
    expect(body.section.renderableCount).toBe(2);
  });

  it('is the same 404 for a section that does not exist and a caller who may not read it', async () => {
    await createApp({ detailRow: null });
    const absent = await request({
      method: 'GET',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
    });
    await app?.close();
    app = undefined;
    await createApp({ permissions: [] });
    const refused = await request({
      method: 'GET',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(absent.statusCode).toBe(404);
    expect(refused.statusCode).toBe(404);
    expect(absent.json()).toEqual(refused.json());
  });

  it('refuses an identifier that could not be one', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/homepage/sections/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });

  it('is not shadowed by the reorder route', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: '/v1/admin/homepage/sections/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { sectionIds: [SECTION] },
    });
    // Declaration order decides this: if `:sectionId` came first, "reorder" would be read as an identifier.
    expect(seen.map((call) => call.name)).toContain('homepageSectionsReorderForStaff');
  });
});

describe('writing a section', () => {
  it('creates one hidden, and validates the config against the type', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/homepage/sections',
      accessToken: ACCESS_TOKEN,
      payload: {
        sectionKey: 'home_latest',
        sectionType: 'latest_listings',
        config: { count: 6 },
        isActive: true,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateHomepageSectionResponseSchema.parse(response.json()).id).toBe(SECTION);
    // No visibility reached the store: a section is always created hidden.
    const input = seen.at(-1)?.input as Record<string, unknown>;
    expect('isActive' in input).toBe(false);
  });

  it('refuses a config that does not match its type', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/homepage/sections',
      accessToken: ACCESS_TOKEN,
      payload: { sectionKey: 'home_picks', sectionType: 'featured_listings', config: { count: 6 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('cannot create a banner_strip', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/homepage/sections',
      accessToken: ACCESS_TOKEN,
      payload: { sectionKey: 'home_strip', sectionType: 'banner_strip', config: {} },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a config carrying a promotion, a placement or a ranking', async () => {
    await createApp();
    for (const config of [
      { ids: ['22222222-2222-4222-8222-222222222222'], promotionId: SECTION },
      { ids: ['22222222-2222-4222-8222-222222222222'], placement: 'homepage' },
      { ids: ['22222222-2222-4222-8222-222222222222'], promoted: true },
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/homepage/sections',
        accessToken: ACCESS_TOKEN,
        payload: { sectionKey: 'home_picks', sectionType: 'featured_listings', config },
      });
      expect(response.statusCode, JSON.stringify(config)).toBe(400);
    }
  });

  it('cannot show a section through the update route', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
      payload: { titleEn: 'Renamed', isActive: true },
    });
    expect(seen.some((call) => call.name === 'homepageSectionStateForStaff')).toBe(false);
  });

  it('refuses a config sent without the type to check it against', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
      payload: { config: { count: 4 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an update with nothing in it', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows and hides a section through its own route', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/homepage/sections/${SECTION}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(response.statusCode).toBe(200);
    expect(HomepageWriteResponseSchema.parse(response.json())).toEqual({ ok: true });
    expect(seen.at(-1)?.input).toMatchObject({ isActive: true });
  });

  it('removes a section', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(seen.at(-1)?.name).toBe('homepageSectionDeleteForStaff');
  });

  it('is a 404 for every write when the caller holds only the read key', async () => {
    const writes: readonly { method: string; url: string; payload?: unknown }[] = [
      {
        method: 'POST',
        url: '/v1/admin/homepage/sections',
        payload: { sectionKey: 'home_latest', sectionType: 'latest_listings', config: { count: 4 } },
      },
      { method: 'PATCH', url: `/v1/admin/homepage/sections/${SECTION}`, payload: { titleEn: 'Renamed' } },
      {
        method: 'PUT',
        url: `/v1/admin/homepage/sections/${SECTION}/state`,
        payload: { isActive: true },
      },
      { method: 'DELETE', url: `/v1/admin/homepage/sections/${SECTION}` },
      { method: 'PUT', url: '/v1/admin/homepage/sections/reorder', payload: { sectionIds: [SECTION] } },
    ];

    for (const entry of writes) {
      // The database is what refuses: it raises 42501 because the caller does not hold the manage key.
      await createApp({ permissions: [READ], writeError: { code: '42501' } });
      const response = await request({ ...entry, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${entry.method} ${entry.url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });
});

describe('the refusals the database raises', () => {
  it('becomes a 409 carrying our own code, never the databases text', async () => {
    for (const [sqlstate, code] of [
      ['23505', 'HOMEPAGE_SECTION_KEY_TAKEN'],
      ['23514', 'HOMEPAGE_SECTION_NOT_ALLOWED'],
    ] as const) {
      await createApp({ writeError: { code: sqlstate } });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/homepage/sections',
        accessToken: ACCESS_TOKEN,
        payload: { sectionKey: 'home_latest', sectionType: 'latest_listings', config: { count: 4 } },
      });
      expect(response.statusCode, sqlstate).toBe(409);
      const body = response.json() as { code: string; detail: string };
      expect(body.code, sqlstate).toBe(code);
      expect(body.detail, sqlstate).not.toContain('the database refused it');
      await app?.close();
      app = undefined;
    }
  });

  it('is a 503 for a SQLSTATE nobody mapped', async () => {
    await createApp({ writeError: { code: '40001' } });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/homepage/sections/${SECTION}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(response.statusCode).toBe(503);
  });

  it('is a 404 when a save named a section that does not exist', async () => {
    await createApp({ saveId: null });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
      payload: { titleEn: 'Renamed' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 when a state change or a delete matched nothing', async () => {
    await createApp({ writeResult: false });
    const state = await request({
      method: 'PUT',
      url: `/v1/admin/homepage/sections/${SECTION}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(state.statusCode).toBe(404);

    const removed = await request({
      method: 'DELETE',
      url: `/v1/admin/homepage/sections/${SECTION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(removed.statusCode).toBe(404);
  });

  it('is still a 200 when a reorder moved nothing, because a stale screen is not a refusal', async () => {
    await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/homepage/sections/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { sectionIds: [SECTION] },
    });
    expect(response.statusCode).toBe(200);
  });
});
