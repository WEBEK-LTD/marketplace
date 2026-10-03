import { describe, expect, it } from 'vitest';
import { readHomepage } from '../src/server/bff/homepage';

/**
 * The public homepage at the BFF boundary (0093).
 *
 * What matters here:
 *
 *   * **no session and no cookie** — the homepage is the same for everyone;
 *   * **null and an empty array are different answers.** Null is "could not be read" and `[]` is "nobody composed
 *     one", and the page renders differently for each: a fresh marketplace has a front page, and an outage says so;
 *   * **a value the database could not have produced is refused**, because the response contract is strict — which
 *     is what keeps a section carrying a promotion, a placement or an empty shelf from reaching a browser.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-homepage-bff-canary-notreal012345a',
} as const;

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  credential: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      credential: sent.get('x-internal-credential'),
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

const CARD = {
  resultType: 'listing',
  slug: 'a-chair',
  title: 'A chair',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: true,
};

const PICKS = {
  sectionType: 'featured_listings',
  sectionKey: 'home_picks',
  title: 'Our picks',
  subtitle: null,
  listings: [CARD],
};

describe('readHomepage', () => {
  it('asks once, with the credential and no cookie', async () => {
    const seen: { value?: Seen } = {};
    const sections = await readHomepage('en', {
      env: ENV,
      fetch: apiReturns(200, { sections: [PICKS] }, seen),
    });
    expect(sections).toHaveLength(1);
    expect(seen.value?.url).toContain('/v1/homepage');
    expect(seen.value?.url).toContain('locale=en');
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('defaults an unrecognised locale rather than sending it on', async () => {
    const seen: { value?: Seen } = {};
    await readHomepage('xx', { env: ENV, fetch: apiReturns(200, { sections: [] }, seen) });
    expect(seen.value?.url).toContain('locale=en');
  });

  it('tells an uncomposed homepage from one it could not read', async () => {
    // An empty array is a real homepage: a marketplace nobody has composed yet.
    expect(await readHomepage('en', { env: ENV, fetch: apiReturns(200, { sections: [] }) })).toEqual([]);

    for (const fetcher of [
      apiUnreachable(),
      apiReturns(503, { status: 503, code: 'SERVICE_UNAVAILABLE' }),
      apiReturns(500, { status: 500, code: 'INTERNAL_ERROR' }),
      apiReturns(403, { status: 403, code: 'BAD_REQUEST' }),
      apiReturns(200, 'not json at all'),
      apiReturns(200, {}),
    ]) {
      // Null, never an empty array: the page must be able to say so rather than claim nothing was composed.
      expect(await readHomepage('en', { env: ENV, fetch: fetcher })).toBeNull();
    }
  });

  it('refuses a section carrying a promotion, a placement or a ranking', async () => {
    for (const extra of [
      { promotionId: '11111111-1111-4111-8111-111111111111' },
      { placement: 'homepage' },
      { ranking: 'promoted_first' },
      { promoted: true },
    ]) {
      const sections = await readHomepage('en', {
        env: ENV,
        fetch: apiReturns(200, { sections: [{ ...PICKS, ...extra }] }),
      });
      expect(sections, JSON.stringify(extra)).toBeNull();
    }
  });

  it('refuses an empty section, which the API should have dropped', async () => {
    // Owner decision C is applied upstream, and the contract makes it unrepresentable here — so a section that
    // arrived empty means something upstream is wrong, not that the page should render a blank shelf.
    const sections = await readHomepage('en', {
      env: ENV,
      fetch: apiReturns(200, { sections: [{ ...PICKS, listings: [] }] }),
    });
    expect(sections).toBeNull();
  });

  it('refuses a banner_strip, which has no public shape at all', async () => {
    const sections = await readHomepage('en', {
      env: ENV,
      fetch: apiReturns(200, {
        sections: [{ sectionType: 'banner_strip', sectionKey: 'home_strip', title: null, subtitle: null }],
      }),
    });
    expect(sections).toBeNull();
  });

  it('accepts a card with no amount, because a listing need not carry one', async () => {
    const sections = await readHomepage('en', {
      env: ENV,
      fetch: apiReturns(200, {
        sections: [{ ...PICKS, listings: [{ ...CARD, priceMinor: null, isNegotiable: null }] }],
      }),
    });
    expect(sections?.[0]?.sectionType === 'featured_listings' && sections[0].listings[0]?.priceMinor).toBeNull();
  });

  it('refuses a card carrying a seller, a location or a view count', async () => {
    for (const extra of [{ sellerSlug: 'shop' }, { location: 'POINT(0 0)' }, { viewCount: 5 }]) {
      const sections = await readHomepage('en', {
        env: ENV,
        fetch: apiReturns(200, { sections: [{ ...PICKS, listings: [{ ...CARD, ...extra }] }] }),
      });
      expect(sections, JSON.stringify(extra)).toBeNull();
    }
  });

  it('accepts every served section type', async () => {
    const sections = await readHomepage('en', {
      env: ENV,
      fetch: apiReturns(200, {
        sections: [
          {
            sectionType: 'hero',
            sectionKey: 'home_hero',
            title: 'Welcome',
            subtitle: null,
            hero: { lead: null, ctaLabel: null, ctaPath: null },
          },
          PICKS,
          { ...PICKS, sectionType: 'latest_listings', sectionKey: 'home_latest' },
          {
            sectionType: 'featured_categories',
            sectionKey: 'home_shelves',
            title: null,
            subtitle: null,
            categories: [{ slug: 'furniture', name: 'Furniture', listingTypeCode: null, icon: null }],
          },
          {
            sectionType: 'featured_sellers',
            sectionKey: 'home_shops',
            title: null,
            subtitle: null,
            sellers: [{ slug: 'good-shop', displayName: 'Good Shop', city: null, bio: null }],
          },
          {
            sectionType: 'blog_highlights',
            sectionKey: 'home_blog',
            title: null,
            subtitle: null,
            posts: [
              {
                slug: 'a-post',
                resolvedLocale: 'en',
                title: 'A Post',
                excerpt: null,
                categorySlug: null,
                categoryName: null,
                publishedAt: '2026-05-01T09:00:00.000Z',
              },
            ],
          },
          {
            sectionType: 'value_props',
            sectionKey: 'home_props',
            title: null,
            subtitle: null,
            items: [{ title: 'Safe', body: 'We check sellers.' }],
          },
          { sectionType: 'rich_text', sectionKey: 'home_about', title: null, subtitle: null, body: 'Prose.' },
        ],
      }),
    });
    expect(sections).toHaveLength(8);
  });
});
