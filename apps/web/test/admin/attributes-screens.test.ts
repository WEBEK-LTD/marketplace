import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AR from '../../messages/admin/ar.json';
import EN from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The attribute and tag console, over real HTTP against the built app.
 *
 * What only a test at this level can prove:
 *
 * **A colleague who may not open a section receives a refusal and no data** — not hidden data, no data. The
 * assertions look for the attribute's key, its label and its identifier in the whole response, flight payload
 * included, because a server component that rendered and then hid a row would still have shipped it.
 *
 * **The two vocabularies are separate keys.** Somebody holding `catalog.attribute.manage` reaches the attributes
 * and learns nothing about a tag, and the reverse. Neither key is `catalog.category.manage`, so neither opens the
 * panel that decides which categories ask for an attribute.
 *
 * **A colleague who may read a category but not manage one sees what it asks and no controls**, which is the
 * distinction `category_attributes`' own write policy makes.
 *
 * **`is_required` is shown as advisory in words**, on the category panel, because that is the whole of what the
 * flag does in this increment.
 *
 * **There is no rename control, no retype control and no delete control anywhere**, because there are no such
 * routes — asserted by the absence of the words, not by their being hidden.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-attributes-canary-credential-abc';
const SESSION = '__Host-mp_admin_access=canary-admin-access-token-not-real';

const STAFF = '11111111-1111-4111-8111-111111111111';
const DEFINITION = 'dd000000-0000-4000-8000-0000000000d1';
const SELECT_DEFINITION = 'dd000000-0000-4000-8000-0000000000d2';
const OPTION = 'ee000000-0000-4000-8000-0000000000e1';
const TAG = 'ff000000-0000-4000-8000-0000000000f1';
const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';

const ATTRIBUTE_MANAGE = 'catalog.attribute.manage';
const TAG_MANAGE = 'catalog.tag.manage';
const CATEGORY_READ = 'catalog.category.read';
const CATEGORY_MANAGE = 'catalog.category.manage';

/** Everything an Admin holds that these sections are about, plus some that they are not. */
const ADMIN = [
  ATTRIBUTE_MANAGE,
  TAG_MANAGE,
  CATEGORY_READ,
  CATEGORY_MANAGE,
  'catalog.listing.read',
  'audit.read',
];

type Who =
  | { kind: 'unauthenticated' }
  | { kind: 'buyer' }
  | { kind: 'staff-aal1' }
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' };

type Data = 'default' | 'empty' | 'unavailable' | 'needsOption' | 'attachedHidden';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

const NUMBER_ATTRIBUTE = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  isFilterable: true,
  isActive: true,
  sortOrder: 1,
  optionCount: 0,
  categoryCount: 2,
  answerCount: 7,
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const SELECT_ATTRIBUTE = {
  ...NUMBER_ATTRIBUTE,
  definitionId: SELECT_DEFINITION,
  key: 'material',
  dataType: 'single_select',
  unit: null,
  nameEn: 'Material',
  nameAr: 'الخامة',
  isActive: false,
  sortOrder: 2,
  optionCount: 1,
  categoryCount: 0,
  answerCount: 0,
};

const OPTION_ROW = {
  optionId: OPTION,
  value: 'oak',
  labelEn: 'Oak',
  labelAr: 'بلوط',
  sortOrder: 1,
  isActive: true,
  answerCount: 3,
};

const TAG_ROW = {
  tagId: TAG,
  slug: 'handmade',
  nameEn: 'Handmade',
  nameAr: 'صناعة يدوية',
  isActive: true,
  usageCount: 4,
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const CATEGORY_ATTRIBUTE = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  isRequired: true,
  isFilterable: true,
  sortOrder: 1,
  isActive: true,
  optionCount: 0,
};

let api: StubApi;
let app: RunningApp;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status, code }));
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'default';
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF,
        displayName: 'Nadia',
        localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en',
      };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: every read answers 404 for a caller without the key it needs, and the
    // vocabularies have no read key of their own.
    if (path === '/v1/admin/attributes') {
      if (!held(ATTRIBUTE_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { attributes: [], canManage: true });
      return json(response, { attributes: [NUMBER_ATTRIBUTE, SELECT_ATTRIBUTE], canManage: true });
    }

    if (path === `/v1/admin/attributes/${DEFINITION}`) {
      if (!held(ATTRIBUTE_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { attribute: NUMBER_ATTRIBUTE, options: [], canManage: true });
    }

    if (path === `/v1/admin/attributes/${SELECT_DEFINITION}`) {
      if (!held(ATTRIBUTE_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      return json(response, {
        attribute: SELECT_ATTRIBUTE,
        options: data === 'needsOption' ? [] : [OPTION_ROW],
        canManage: true,
      });
    }

    if (path === '/v1/admin/tags') {
      if (!held(TAG_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { tags: [], canManage: true });
      return json(response, { tags: [TAG_ROW], canManage: true });
    }

    if (path === `/v1/admin/categories/${CATEGORY}/attributes`) {
      if (!held(CATEGORY_READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'empty') return json(response, { attributes: [], canManage: held(CATEGORY_MANAGE) });
      return json(response, {
        attributes: [
          data === 'attachedHidden' ? { ...CATEGORY_ATTRIBUTE, isActive: false } : CATEGORY_ATTRIBUTE,
        ],
        canManage: held(CATEGORY_MANAGE),
      });
    }

    // The category screen reads the category itself too; a minimal answer keeps this suite about attributes.
    if (path === `/v1/admin/categories/${CATEGORY}`) {
      if (!held(CATEGORY_READ)) return problem(response, 404, 'NOT_FOUND');
      return json(response, {
        category: {
          categoryId: CATEGORY,
          parentId: null,
          parentSlug: null,
          slug: 'furniture',
          depth: 0,
          sortOrder: 1,
          listingTypeCode: 'product',
          isActive: true,
          isVisible: true,
          childCount: 0,
          listingCount: 0,
          translatedLocales: ['en'],
          createdAt: '2026-04-01T09:00:00.000Z',
          updatedAt: '2026-05-02T09:00:00.000Z',
          canManage: held(CATEGORY_MANAGE),
        },
        translations: [
          {
            localeCode: 'en',
            name: 'Furniture',
            description: null,
            metaTitle: null,
            metaDescription: null,
            updatedAt: '2026-05-02T09:00:00.000Z',
          },
        ],
      });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie: string | null = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    headers: cookie === null ? {} : { cookie },
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text() };
}

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

describe('who may open the attribute section', () => {
  it('shows the vocabulary to a colleague holding the attribute key', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/catalog/attributes');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.attributes.title);
    expect(html).toContain('Width');
    expect(html).toContain('width');
  });

  it('gives a buyer a refusal and not one word about an attribute', async () => {
    apiServes({ who: { kind: 'buyer' } });
    const { html } = await get('/catalog/attributes');
    for (const leak of ['Width', DEFINITION, 'العرض']) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('gives a staff session at aal1 a refusal and no data', async () => {
    apiServes({ who: { kind: 'staff-aal1' } });
    const { html } = await get('/catalog/attributes');
    for (const leak of ['Width', DEFINITION]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('gives a colleague holding only the tag key a refusal and no attribute data', async () => {
    apiServes({ who: { kind: 'staff', permissions: [TAG_MANAGE] } });
    const { html } = await get('/catalog/attributes');
    for (const leak of ['Width', DEFINITION]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('gives a colleague holding only the attribute key a refusal and no tag data', async () => {
    apiServes({ who: { kind: 'staff', permissions: [ATTRIBUTE_MANAGE] } });
    const { html } = await get('/catalog/tags');
    for (const leak of ['Handmade', 'handmade', TAG]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('sends somebody with no session at all to sign in', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    const { html } = await get('/catalog/attributes', null);
    expect(html).not.toContain('Width');
  });
});

describe('the vocabulary', () => {
  it('reports the kind of answer, the unit, the state and what uses it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/attributes');
    expect(html).toContain(EN.Attributes.columnType);
    expect(html).toContain(EN.Attributes.typeNumber);
    expect(html).toContain('cm');
    expect(html).toContain(EN.Attributes.stateShown);
    expect(html).toContain('2 categories ask it');
    expect(html).toContain('7 answers');
  });

  it('shows the hidden ones too, so one can be brought back', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/attributes');
    expect(html).toContain('Material');
    expect(html).toContain(EN.Attributes.stateHidden);
  });

  it('says out loud that a list with no option cannot be shown', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'needsOption' });
    const { html } = await get(`/catalog/attributes/${SELECT_DEFINITION}`);
    expect(html).toContain(EN.Attributes.noOptionsTitle);
    expect(html).toContain(EN.Attributes.noOptionsBody);
  });

  it('offers an empty state rather than a blank table', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get('/catalog/attributes');
    expect(html).toContain(EN.Attributes.emptyTitle);
    expect(html).toContain(EN.Attributes.emptyBody);
  });

  it('says the vocabulary could not be read, rather than that there is nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { html } = await get('/catalog/attributes');
    expect(html).toContain(EN.Attributes.unavailableTitle);
    expect(html).not.toContain(EN.Attributes.emptyBody);
  });

  it('renders in Arabic too, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get('/catalog/attributes');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.attributes.title);
    expect(html).toContain(AR.Attributes.vocabularyHeading);
    expect(html).toContain('العرض');
  });
});

describe('one attribute', () => {
  it('says the name in the data and the kind of answer cannot be changed', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/attributes/${DEFINITION}`);
    expect(html).toContain(EN.Attributes.identityNote);
    // The key is shown as a fact about the attribute, and there is no field anywhere that could change it.
    expect(html).toContain(EN.Attributes.keyLabel);
  });

  it('offers the controls that exist and none that do not', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/attributes/${DEFINITION}`);
    expect(html).toContain(EN.Attributes.saveSubmit);
    expect(html).toContain(EN.Attributes.hide);
    // Nothing anywhere offers to delete or to rename the identity.
    for (const absent of ['Delete', 'Remove the attribute', 'Rename']) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('shows an option with how many listings chose it, and the option values', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/attributes/${SELECT_DEFINITION}`);
    expect(html).toContain('Oak');
    expect(html).toContain('oak');
    expect(html).toContain('3 answers');
    expect(html).toContain(EN.Attributes.addOptionSubmit);
  });

  it('answers nothing-to-show for an address that names nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/attributes/not-a-uuid');
    expect(html).toContain(EN.Attributes.notFoundTitle);
  });
});

describe('tags', () => {
  it('shows every tag with how many listings carry it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/catalog/tags');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.tags.title);
    expect(html).toContain('Handmade');
    expect(html).toContain('handmade');
    expect(html).toContain('4 listings');
  });

  it('offers a rename and a hide, and nothing that changes the address', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/tags');
    expect(html).toContain(EN.Attributes.saveSubmit);
    expect(html).toContain(EN.Attributes.hide);
    expect(html).toContain(EN.Attributes.tagSlugHint);
    expect(html).not.toContain('Delete');
  });

  it('offers an empty state rather than a blank table', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get('/catalog/tags');
    expect(html).toContain(EN.Attributes.noTagsTitle);
  });

  it('renders in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get('/catalog/tags');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Attributes.tagsHeading);
    expect(html).toContain('صناعة يدوية');
  });
});

describe('what a category asks', () => {
  it('shows the attributes a category asks for, on the category’s own screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(status).toBe(200);
    expect(html).toContain(EN.Attributes.categoryHeading);
    expect(html).toContain('Width');
    expect(html).toContain(EN.Attributes.askedRequired);
  });

  it('says in words that required is advisory for now', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Attributes.advisoryNote);
    expect(html).toContain(EN.Attributes.requiredHint);
  });

  it('offers attaching and detaching to somebody who manages categories', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Attributes.attachSubmit);
    expect(html).toContain(EN.Attributes.detachSubmit);
  });

  it('shows a category reader what it asks and no control at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: [CATEGORY_READ, ATTRIBUTE_MANAGE] } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain('Width');
    expect(html).toContain(EN.Attributes.categoryReadOnlyNote);
    for (const absent of [EN.Attributes.attachSubmit, EN.Attributes.detachSubmit]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('offers no attribute to attach to somebody who cannot read the vocabulary', async () => {
    apiServes({ who: { kind: 'staff', permissions: [CATEGORY_READ, CATEGORY_MANAGE] } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Attributes.noChoices);
    expect(html).not.toContain(EN.Attributes.attachSubmit);
  });

  it('says out loud when an attached attribute is hidden and so is asked of nobody', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'attachedHidden' });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Attributes.attachedButHidden);
  });

  it('says a category asking nothing asks nothing, rather than showing a blank table', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Attributes.noCategoryAttributesTitle);
  });
});

describe('what crosses to the API', () => {
  it('sends the session token on one internal hop and never the browser’s cookie', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    await get('/catalog/attributes');
    const reads = api.seen.filter((seen) => seen.url.startsWith('/v1/admin/attributes'));
    expect(reads.length).toBeGreaterThan(0);
    for (const seen of reads) {
      expect(seen.credential).toBe(CANARY_CREDENTIAL);
      expect(seen.cookie ?? '', seen.url).not.toContain('mp_admin_access');
    }
  });

  it('names no account, role, permission or assurance level in anything it sends', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    await get('/catalog/attributes');
    for (const seen of api.seen) {
      const body = seen.body ?? '';
      // `admin` is deliberately absent from this list: every one of these paths is under /v1/admin.
      for (const leak of [STAFF, 'aal2', ATTRIBUTE_MANAGE, 'roles']) {
        expect(`${seen.url}${body}`, leak).not.toContain(leak);
      }
    }
  });
});
