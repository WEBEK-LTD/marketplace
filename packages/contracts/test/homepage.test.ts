import { describe, expect, it } from 'vitest';
import {
  CreateHomepageSectionRequestSchema,
  HOMEPAGE_SECTION_COUNT_MAX,
  HOMEPAGE_SECTION_IDS_MAX,
  HOMEPAGE_SECTION_KEY_PATTERN,
  HOMEPAGE_SECTION_TYPES,
  HOMEPAGE_SERVED_SECTION_TYPES,
  HomepageSectionConfigSchema,
  HomepageSectionDetailSchema,
  HomepageSectionStateRequestSchema,
  HomepageSectionsResponseSchema,
  PublicHomepageResponseSchema,
  ReorderHomepageSectionsRequestSchema,
  UpdateHomepageSectionRequestSchema,
  homepageConfigIsValid,
} from '../src/index.js';

/**
 * The homepage's contract (0093).
 *
 * What matters here: the vocabulary matches 0030's own constraint; each section type has exactly one config shape
 * and a shape belonging to another type is refused; the public response can never carry an empty section; and
 * every one of the owner's decisions is visible as something this contract cannot express — no promotion or
 * placement field anywhere, no `banner_strip` config, no markup flag on `rich_text`.
 */

const ID = '11111111-1111-4111-8111-111111111111';

describe('the section vocabulary', () => {
  it('is 0030s nine types, stored', () => {
    expect(HOMEPAGE_SECTION_TYPES).toEqual([
      'hero',
      'banner_strip',
      'featured_listings',
      'featured_categories',
      'featured_sellers',
      'latest_listings',
      'blog_highlights',
      'value_props',
      'rich_text',
    ]);
  });

  it('serves eight of them, and banner_strip is the one it does not', () => {
    expect(HOMEPAGE_SERVED_SECTION_TYPES).toHaveLength(8);
    expect(HOMEPAGE_SERVED_SECTION_TYPES as readonly string[]).not.toContain('banner_strip');
    // Every served type is still one 0030 allows, so this is an exclusion rather than an invention.
    for (const type of HOMEPAGE_SERVED_SECTION_TYPES) {
      expect(HOMEPAGE_SECTION_TYPES as readonly string[], type).toContain(type);
    }
  });

  it('accepts the keys 0030 accepts and refuses the rest', () => {
    for (const key of ['hero', 'home_hero', 'a1', 'home_hero_2']) {
      expect(HOMEPAGE_SECTION_KEY_PATTERN.test(key), key).toBe(true);
    }
    for (const key of ['', '1hero', 'Hero', 'home-hero', 'home hero', '_hero']) {
      expect(HOMEPAGE_SECTION_KEY_PATTERN.test(key), key).toBe(false);
    }
  });
});

describe('the configuration shapes', () => {
  it('gives each type exactly one shape', () => {
    expect(homepageConfigIsValid('hero', { lead: 'Find what you need.' })).toBe(true);
    expect(homepageConfigIsValid('featured_listings', { ids: [ID] })).toBe(true);
    expect(homepageConfigIsValid('featured_categories', { ids: [ID] })).toBe(true);
    expect(homepageConfigIsValid('featured_sellers', { ids: [ID] })).toBe(true);
    expect(homepageConfigIsValid('latest_listings', { count: 8 })).toBe(true);
    expect(homepageConfigIsValid('blog_highlights', { count: 3 })).toBe(true);
    expect(homepageConfigIsValid('value_props', { items: [{ titleEn: 'Safe', bodyEn: 'We check sellers.' }] }))
      .toBe(true);
    expect(homepageConfigIsValid('rich_text', { bodyEn: 'Some prose.' })).toBe(true);
  });

  it('refuses a shape that belongs to another type', () => {
    // The whole reason the union exists: a count on a curated section, or ids on a counted one, would otherwise
    // be carried along and ignored by whichever renderer happened to read it.
    expect(homepageConfigIsValid('featured_listings', { count: 8 })).toBe(false);
    expect(homepageConfigIsValid('latest_listings', { ids: [ID] })).toBe(false);
    expect(homepageConfigIsValid('hero', { ids: [ID] })).toBe(false);
    expect(homepageConfigIsValid('rich_text', { count: 3 })).toBe(false);
  });

  it('refuses a field nobody declared, on every type', () => {
    expect(homepageConfigIsValid('featured_listings', { ids: [ID], weight: 2 })).toBe(false);
    expect(homepageConfigIsValid('latest_listings', { count: 8, sort: 'popular' })).toBe(false);
    expect(homepageConfigIsValid('hero', { lead: 'x', imageId: ID })).toBe(false);
  });

  it('has no shape for banner_strip, because a banner is its image and there is no media origin', () => {
    for (const config of [{}, { ids: [ID] }, { count: 3 }, { bannerIds: [ID] }]) {
      expect(homepageConfigIsValid('banner_strip', config), JSON.stringify(config)).toBe(false);
    }
  });

  it('cannot express a promotion, a placement, a ranking or a payment anywhere', () => {
    // Owner decision A as an absence: a featured section is editorial, so there is no field for any of this and
    // no member of the union that would accept one.
    for (const [type, config] of [
      ['featured_listings', { ids: [ID], promotionId: ID }],
      ['featured_listings', { ids: [ID], placement: 'homepage' }],
      ['featured_listings', { promoted: true }],
      ['latest_listings', { count: 8, ranking: 'promoted_first' }],
      ['featured_sellers', { ids: [ID], paid: true }],
    ] as const) {
      expect(homepageConfigIsValid(type, config), JSON.stringify(config)).toBe(false);
    }
  });

  it('bounds a selection and a count', () => {
    const tooMany = Array.from({ length: HOMEPAGE_SECTION_IDS_MAX + 1 }, () => ID);
    expect(homepageConfigIsValid('featured_listings', { ids: tooMany })).toBe(false);
    expect(homepageConfigIsValid('featured_listings', { ids: [] })).toBe(true);
    expect(homepageConfigIsValid('latest_listings', { count: 0 })).toBe(false);
    expect(homepageConfigIsValid('latest_listings', { count: HOMEPAGE_SECTION_COUNT_MAX + 1 })).toBe(false);
  });

  it('keeps a hero cta on this site', () => {
    expect(homepageConfigIsValid('hero', { ctaPath: '/listings' })).toBe(true);
    for (const path of ['https://evil.test', '//evil.test', 'listings', '/ listings']) {
      expect(homepageConfigIsValid('hero', { ctaPath: path }), path).toBe(false);
    }
  });

  it('has no markup flag on rich_text, because it is text', () => {
    expect(homepageConfigIsValid('rich_text', { bodyEn: 'x', format: 'html' })).toBe(false);
    expect(homepageConfigIsValid('rich_text', { bodyHtml: '<b>x</b>' })).toBe(false);
  });

  it('discriminates on the type rather than guessing from the shape', () => {
    const parsed = HomepageSectionConfigSchema.parse({ sectionType: 'latest_listings', config: { count: 4 } });
    expect(parsed.sectionType === 'latest_listings' && parsed.config.count).toBe(4);
    expect(HomepageSectionConfigSchema.safeParse({ sectionType: 'banner_strip', config: {} }).success).toBe(false);
  });
});

describe('the public response', () => {
  const HERO = {
    sectionType: 'hero',
    sectionKey: 'home_hero',
    title: 'Welcome',
    subtitle: null,
    hero: { lead: 'Find what you need.', ctaLabel: 'Browse', ctaPath: '/listings' },
  } as const;

  const CARD = {
    resultType: 'listing',
    slug: 'a-chair',
    title: 'A chair',
    city: 'Cairo',
    priceMinor: '10000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: true,
      } as const;

  /** Only what every member carries. Each member is strict, so a payload must not leak between types. */
  const base = { title: 'Welcome', subtitle: null } as const;

  it('carries a resolved section', () => {
    const parsed = PublicHomepageResponseSchema.parse({
      sections: [
        HERO,
        { ...base, sectionType: 'featured_listings', sectionKey: 'home_picks', listings: [CARD] },
      ],
    });
    expect(parsed.sections).toHaveLength(2);
  });

  it('cannot carry an empty section, because an empty one is skipped before it gets here', () => {
    // Owner decision C in the type system: a renderer never has to decide what an empty shelf means.
    for (const empty of [
      { ...base, sectionType: 'featured_listings', sectionKey: 'k', listings: [] },
      { ...base, sectionType: 'featured_categories', sectionKey: 'k', categories: [] },
      { ...base, sectionType: 'featured_sellers', sectionKey: 'k', sellers: [] },
      { ...base, sectionType: 'blog_highlights', sectionKey: 'k', posts: [] },
      { ...base, sectionType: 'value_props', sectionKey: 'k', items: [] },
    ]) {
      expect(
        PublicHomepageResponseSchema.safeParse({ sections: [empty] }).success,
        String((empty as { sectionType: string }).sectionType),
      ).toBe(false);
    }
  });

  it('has no banner_strip member at all', () => {
    expect(
      PublicHomepageResponseSchema.safeParse({
        sections: [{ sectionType: 'banner_strip', sectionKey: 'k', title: null, subtitle: null }],
      }).success,
    ).toBe(false);
  });

  it('carries a card with no amount as a null price, never as a zero', () => {
    // `listings.price_minor` is nullable and a custom-priced service is the ordinary case. A card with no amount
    // must be representable, because the alternative is the API inventing an amount nobody set.
    const parsed = PublicHomepageResponseSchema.parse({
      sections: [
        {
          ...base,
          sectionType: 'featured_listings',
          sectionKey: 'home_picks',
          listings: [{ ...CARD, resultType: 'service', priceMinor: null, isNegotiable: null }],
        },
      ],
    });
    const first = parsed.sections[0];
    expect(first?.sectionType === 'featured_listings' && first.listings[0]?.priceMinor).toBeNull();
  });

  it('refuses a price that is not an exact non-negative integer in text', () => {
    for (const bad of ['', '0010', '12.50', '-100', 100, '1e3']) {
      expect(
        PublicHomepageResponseSchema.safeParse({
          sections: [
            {
              ...base,
              sectionType: 'featured_listings',
              sectionKey: 'k',
              listings: [{ ...CARD, priceMinor: bad }],
            },
          ],
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('refuses a card carrying a seller, a location, a view count or a field no card shows', () => {
    for (const extra of [
      { sellerSlug: 'shop' },
      { location: 'POINT(0 0)' },
      { viewCount: 5 },
      // Dropped on purpose: a compact card renders neither, so the public contract does not carry them.
      { pricingModel: 'custom' },
      { deliveryDays: 3 },
    ]) {
      expect(
        PublicHomepageResponseSchema.safeParse({
          sections: [
            { ...base, sectionType: 'featured_listings', sectionKey: 'k', listings: [{ ...CARD, ...extra }] },
          ],
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('serves rich text as one plain string', () => {
    const parsed = PublicHomepageResponseSchema.parse({
      sections: [{ sectionType: 'rich_text', sectionKey: 'home_about', title: null, subtitle: null, body: 'Prose.' }],
    });
    expect(parsed.sections[0]?.sectionType === 'rich_text' && parsed.sections[0].body).toBe('Prose.');
  });

  it('accepts a homepage with no sections at all, which is a fresh install', () => {
    expect(PublicHomepageResponseSchema.parse({ sections: [] }).sections).toEqual([]);
  });
});

describe('creating and updating a section', () => {
  it('validates the config against the type it was given', () => {
    expect(
      CreateHomepageSectionRequestSchema.safeParse({
        sectionKey: 'home_picks',
        sectionType: 'featured_listings',
        config: { ids: [ID] },
      }).success,
    ).toBe(true);
    expect(
      CreateHomepageSectionRequestSchema.safeParse({
        sectionKey: 'home_picks',
        sectionType: 'featured_listings',
        config: { count: 4 },
      }).success,
    ).toBe(false);
  });

  it('cannot create a banner_strip', () => {
    expect(
      CreateHomepageSectionRequestSchema.safeParse({
        sectionKey: 'home_strip',
        sectionType: 'banner_strip',
        config: {},
      }).success,
    ).toBe(false);
  });

  it('cannot show a section at creation', () => {
    const parsed = CreateHomepageSectionRequestSchema.parse({
      sectionKey: 'home_picks',
      sectionType: 'featured_listings',
      config: { ids: [] },
      isActive: true,
    }) as Record<string, unknown>;
    expect('isActive' in parsed).toBe(false);
  });

  it('needs at least one field to update', () => {
    expect(UpdateHomepageSectionRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateHomepageSectionRequestSchema.safeParse({ titleEn: 'Renamed' }).success).toBe(true);
  });

  it('refuses a config with no type to check it against', () => {
    expect(UpdateHomepageSectionRequestSchema.safeParse({ config: { ids: [ID] } }).success).toBe(false);
    expect(
      UpdateHomepageSectionRequestSchema.safeParse({ sectionType: 'featured_listings', config: { ids: [ID] } })
        .success,
    ).toBe(true);
  });

  it('has no isActive field, so editing a section cannot publish it', () => {
    const parsed = UpdateHomepageSectionRequestSchema.parse({
      titleEn: 'Renamed',
      isActive: true,
    }) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['titleEn']);
  });

  it('keeps showing a section to its own request', () => {
    expect(HomepageSectionStateRequestSchema.parse({ isActive: true }).isActive).toBe(true);
    expect(HomepageSectionStateRequestSchema.safeParse({ isActive: true, sortOrder: 0 }).success).toBe(false);
  });

  it('takes the whole order at once', () => {
    expect(ReorderHomepageSectionsRequestSchema.parse({ sectionIds: [ID] }).sectionIds).toEqual([ID]);
    expect(ReorderHomepageSectionsRequestSchema.safeParse({ sectionIds: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('the authoring views', () => {
  const DETAIL = {
    id: ID,
    sectionKey: 'home_picks',
    sectionType: 'featured_listings',
    titleEn: 'Our picks',
    titleAr: null,
    subtitleEn: null,
    subtitleAr: null,
    config: { ids: [ID] },
    sortOrder: 20,
    isActive: true,
    isServed: true,
    isConfigured: true,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    canManage: true,
    chosenCount: 4,
    renderableCount: 2,
  } as const;

  it('reports how much of a section is still renderable', () => {
    const parsed = HomepageSectionDetailSchema.parse(DETAIL);
    expect(parsed.chosenCount).toBe(4);
    expect(parsed.renderableCount).toBe(2);
  });

  it('reports the manage capability rather than a role name', () => {
    const { canManage: _omitted, ...without } = DETAIL;
    expect(HomepageSectionDetailSchema.safeParse(without).success).toBe(false);
  });

  it('lets a stored banner_strip be listed, so nothing is hidden from an operator', () => {
    const listed = HomepageSectionsResponseSchema.parse({
      sections: [
        {
          id: ID,
          sectionKey: 'home_strip',
          sectionType: 'banner_strip',
          titleEn: 'A strip',
          titleAr: null,
          sortOrder: 70,
          isActive: true,
          // Marked as one the homepage will not render, which is the honest way to show it.
          isServed: false,
          isConfigured: false,
          updatedAt: '2026-05-02T09:00:00.000Z',
        },
      ],
      canManage: false,
    });
    expect(listed.sections[0]?.isServed).toBe(false);
    expect(listed.canManage).toBe(false);
  });

  it('refuses a field nobody declared on the detail', () => {
    expect(HomepageSectionDetailSchema.safeParse({ ...DETAIL, promotionId: ID }).success).toBe(false);
  });
});
