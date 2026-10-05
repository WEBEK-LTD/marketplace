import { describe, expect, it } from 'vitest';
import {
  CLEARABLE_UPDATE_FIELDS,
  EMPTY_LISTING_CREATE_VALUES,
  LISTING_ACTIONS,
  LISTING_UPDATE_FIELDS,
  archiveListing,
  buildListingCreate,
  buildListingUpdate,
  initialListingUpdateValues,
  listingActions,
  renderableListing,
  sellerCanMutate,
  submitListingCreate,
  submitListingForReview,
  submitListingUpdate,
  type ListingCreateValues,
  type RenderableListing,
} from '../src/components/seller-listing-forms';

/**
 * The listing forms' logic (Phase 6-F).
 *
 * The pure half of the UI, tested without a browser, because that is where the decisions are:
 *
 *   * which of S-8's actions each listing state offers, exhausted over the whole status vocabulary;
 *   * what a blank box means — clear, or refuse — for each of the nine editable fields;
 *   * that only what changed is sent, so a partial update is actually partial;
 *   * that nothing is optimistic: every outcome is what the server said, validated, and a drifted body is a
 *     failure rather than a rendered guess;
 *   * that no request carries a status, an owner or an identifier.
 *
 * No React, no DOM, no network: `fetch` is a function.
 */

const LISTING: RenderableListing = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  status: 'draft',
  currencyCode: 'EGP',
  priceMinor: 9900,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  mediaCount: 2,
};

const VALID_CREATE: ListingCreateValues = {
  ...EMPTY_LISTING_CREATE_VALUES,
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
};

function responder(status: number, payload: unknown): typeof fetch {
  return (async () =>
    new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

function recorder(
  status: number,
  payload: unknown,
  seen: { url: string; init: RequestInit | undefined }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('which actions a listing offers', () => {
  it('lets a draft be edited and submitted, and nothing else', () => {
    expect(listingActions('draft', true)).toEqual(['edit', 'submit']);
  });

  it('lets the live pair be archived, which is the listings schema’s own notion of purchasable', () => {
    expect(listingActions('approved', true)).toEqual(['archive']);
    expect(listingActions('active', true)).toEqual(['archive']);
  });

  it.each(['pending_review', 'sold', 'expired', 'archived', 'rejected', 'suspended', 'deleted'])(
    'offers nothing at all for %s',
    (status) => {
      expect(listingActions(status, true)).toEqual([]);
    },
  );

  it('offers nothing whatsoever when the storefront cannot mutate, whatever the listing says', () => {
    for (const status of ['draft', 'approved', 'active', 'pending_review']) {
      expect(listingActions(status, false), status).toEqual([]);
    }
  });

  it('knows which storefront states may mutate at all', () => {
    expect(sellerCanMutate('pending')).toBe(true);
    expect(sellerCanMutate('active')).toBe(true);
    expect(sellerCanMutate('suspended')).toBe(false);
    expect(sellerCanMutate('closed')).toBe(false);
    expect(sellerCanMutate('something-new')).toBe(false);
  });

  it('has no delete among its actions, anywhere', () => {
    expect([...LISTING_ACTIONS]).toEqual(['edit', 'submit', 'archive']);
    expect(LISTING_ACTIONS).not.toContain('delete');
  });
});

describe('the render projection', () => {
  it('carries exactly the fields a seller surface shows, and no identifier', () => {
    const projected = renderableListing({
      ...LISTING,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-02T10:00:00.000Z',
      submittedAt: null,
      archivedAt: null,
    } as never);

    expect(Object.keys(projected).sort()).toEqual(
      [
        'categorySlug',
        'city',
        'contentLanguage',
        'countryCode',
        'currencyCode',
        'description',
        'governorate',
        'isNegotiable',
        'listingTypeCode',
        'mediaCount',
        'priceMinor',
        'slug',
        'status',
        'title',
      ].sort(),
    );
    const payload = JSON.stringify(projected);
    for (const field of ['sellerUserId', 'categoryId', 'approvedAt', 'viewCount', 'id"']) {
      expect(payload, field).not.toContain(field);
    }
  });
});

describe('building a creation', () => {
  it('builds the minimum valid draft: no price, no media, no detail row', () => {
    const built = buildListingCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.priceMinor).toBeUndefined();
    expect(JSON.stringify(built.body)).not.toContain('media');
  });

  it('never sends a status, an owner or an identifier', () => {
    const built = buildListingCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = JSON.stringify(built.body);
    for (const field of ['status', 'sellerUserId', 'userId', 'listingId', 'categoryId', 'approvedAt']) {
      expect(payload, field).not.toContain(field);
    }
  });

  it.each(['slug', 'title', 'description', 'categorySlug', 'currencyCode'] as const)(
    'reports a blank %s as incomplete, which is a different message from invalid',
    (field) => {
      const built = buildListingCreate({ ...VALID_CREATE, [field]: '' });
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.incomplete).toBe(true);
    },
  );

  it('refuses a price that is not a whole number rather than coercing one', () => {
    for (const price of ['12.5', '-1', 'free', '1e3']) {
      const built = buildListingCreate({ ...VALID_CREATE, priceMinor: price });
      expect(built.ok, price).toBe(false);
    }
    const good = buildListingCreate({ ...VALID_CREATE, priceMinor: '9900' });
    expect(good.ok && good.body.priceMinor).toBe(9900);
  });

  it('omits the optional location fields when they are blank', () => {
    const built = buildListingCreate({ ...VALID_CREATE, governorate: '  ', city: '' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.hasOwn(built.body, 'governorate')).toBe(false);
    expect(Object.hasOwn(built.body, 'city')).toBe(false);
  });

  it('names no currency of its own: the starting value is empty', () => {
    // Owner decision E3 — a currency written into a form is a code that keeps being right until the day
    // the enabled set changes, and is then silently wrong.
    expect(EMPTY_LISTING_CREATE_VALUES.currencyCode).toBe('');
  });

  it('refuses a slug the listings table would refuse', () => {
    for (const slug of ['A-Chair', 'ab', '-leading', 'trailing-', 'a chair']) {
      expect(buildListingCreate({ ...VALID_CREATE, slug }).ok, slug).toBe(false);
    }
  });
});

describe('building an edit', () => {
  const starting = initialListingUpdateValues(LISTING);

  it('fills every editable field from the row, which is why a blank box is unambiguous here', () => {
    expect(Object.keys(starting).sort()).toEqual([...LISTING_UPDATE_FIELDS].sort());
    expect(starting.title).toBe('A Chair');
    expect(starting.priceMinor).toBe('9900');
    expect(starting.city).toBe('Cairo');
    expect(starting.governorate).toBe('');
  });

  it('sends only what changed', () => {
    const built = buildListingUpdate({ ...starting, title: 'Renamed Chair' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({ title: 'Renamed Chair' });
    expect(built.changed).toBe(true);
  });

  it('reports an untouched form as changing nothing, so there is no round trip to make', () => {
    const built = buildListingUpdate(starting, starting);
    expect(built.ok && built.changed).toBe(false);
  });

  it.each([...CLEARABLE_UPDATE_FIELDS])('sends a blank %s as null, because that column may be empty', (field) => {
    const built = buildListingUpdate({ ...starting, [field]: '' }, { ...starting, [field]: 'something' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body[field as keyof typeof built.body]).toBeNull();
  });

  it.each(['title', 'description', 'contentLanguage', 'currencyCode', 'countryCode'] as const)(
    'refuses a blank %s as incomplete: that column cannot be emptied',
    (field) => {
      const built = buildListingUpdate({ ...starting, [field]: '' }, starting);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.incomplete).toBe(true);
    },
  );

  it('does not send a field that was already empty and still is', () => {
    const built = buildListingUpdate({ ...starting, title: 'Renamed' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // `governorate` started blank and stayed blank: there is nothing to say about it.
    expect(Object.hasOwn(built.body, 'governorate')).toBe(false);
  });

  it('treats the negotiable checkbox as a boolean, sent only when it moved', () => {
    const on = buildListingUpdate({ ...starting, isNegotiable: 'yes' }, starting);
    expect(on.ok && on.body.isNegotiable).toBe(true);

    const unchanged = buildListingUpdate(starting, starting);
    expect(unchanged.ok && Object.hasOwn(unchanged.body, 'isNegotiable')).toBe(false);
  });

  it('refuses a price that is not a whole number', () => {
    expect(buildListingUpdate({ ...starting, priceMinor: '12.5' }, starting).ok).toBe(false);
  });

  it('can never send a slug, a type, a category or a status: there is no field for them', () => {
    const built = buildListingUpdate({ ...starting, title: 'Renamed' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = JSON.stringify(built.body);
    for (const field of ['slug', 'listingTypeCode', 'categorySlug', 'status', 'submittedAt']) {
      expect(payload, field).not.toContain(field);
    }
  });
});

describe('sending a write', () => {
  it('posts a creation same-origin and reports the committed status', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const outcome = await submitListingCreate(
      { ...VALID_CREATE, priceMinor: undefined } as never,
      recorder(201, { listing: { slug: 'a-chair', status: 'draft' } }, seen),
    );

    expect(outcome).toEqual({ kind: 'ok', slug: 'a-chair', status: 'draft' });
    expect(seen[0]?.url).toBe('/api/sellers/me/listings');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.credentials).toBe('same-origin');
  });

  it('patches an edit at the listing’s own address, percent-encoded', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    await submitListingUpdate('a chair/../x', { title: 'Renamed' }, recorder(200, { listing: { slug: 'a', status: 'draft' } }, seen));
    expect(seen[0]?.url).toBe('/api/sellers/me/listings/a%20chair%2F..%2Fx');
    expect(seen[0]?.init?.method).toBe('PATCH');
  });

  it.each([
    ['a submission', submitListingForReview, 'submission'],
    ['an archive', archiveListing, 'archive'],
  ])('sends %s with no body at all', async (_name, send, segment) => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    await send('a-chair', recorder(200, { listing: { slug: 'a-chair', status: 'archived' } }, seen));

    expect(seen[0]?.url).toBe(`/api/sellers/me/listings/a-chair/${segment}`);
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.body).toBeUndefined();
    // No content-type either: there is nothing to describe.
    expect(seen[0]?.init?.headers).toBeUndefined();
  });

  it('tells the three conflicts apart, because the remedies differ', async () => {
    const at = async (code: string) =>
      submitListingForReview('a-chair', responder(409, { code, detail: 'refused' }));

    expect((await at('SELLER_LISTING_NOT_EDITABLE')).kind).toBe('not_editable');
    expect((await at('SELLER_PROFILE_NOT_EDITABLE')).kind).toBe('not_editable');
    expect((await at('SELLER_LISTING_SLUG_TAKEN')).kind).toBe('slug_taken');
    expect((await at('SELLER_LISTING_INCOMPLETE')).kind).toBe('incomplete');
    // A conflict code this version does not know is not guessed at.
    expect((await at('SOMETHING_NEW')).kind).toBe('unavailable');
  });

  it('reports the other refusals without guessing', async () => {
    expect((await submitListingForReview('a-chair', responder(401, {}))).kind).toBe('unauthenticated');
    expect((await submitListingForReview('a-chair', responder(404, {}))).kind).toBe('not_found');
    expect((await submitListingForReview('a-chair', responder(400, {}))).kind).toBe('invalid');
    // A throttled write is not invalid information, so it does not get the "invalid" sentence.
    expect((await submitListingForReview('a-chair', responder(429, {}))).kind).toBe('unavailable');
    expect((await submitListingForReview('a-chair', responder(503, {}))).kind).toBe('unavailable');
  });

  it('refuses a success body that has drifted rather than rendering a guess', async () => {
    expect((await submitListingForReview('a-chair', responder(200, { listing: {} }))).kind).toBe('unavailable');
    expect(
      (await submitListingForReview('a-chair', responder(200, { listing: { slug: 'a', status: 'deleted' } })))
        .kind,
    ).toBe('unavailable');
    expect((await submitListingForReview('a-chair', responder(200, 'not json'))).kind).toBe('unavailable');
  });

  it('compares the success status exactly: a 200 where 201 is contracted is not a success', async () => {
    const outcome = await submitListingCreate(
      VALID_CREATE as never,
      responder(200, { listing: { slug: 'a-chair', status: 'draft' } }),
    );
    expect(outcome.kind).toBe('unavailable');
  });

  it('reports an unreachable origin as unavailable rather than throwing at a form', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await archiveListing('a-chair', failing)).kind).toBe('unavailable');
  });
});
