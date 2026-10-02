import { describe, expect, it } from 'vitest';
import {
  CLEARABLE_SERVICE_FIELDS,
  EMPTY_SERVICE_CREATE_VALUES,
  REQUIRED_DETAIL_FIELDS,
  SERVICE_UPDATE_FIELDS,
  buildServiceCreate,
  buildServiceUpdate,
  initialServiceUpdateValues,
  renderableService,
  serviceActions,
  serviceAmount,
  submitServiceCreate,
  submitServiceUpdate,
  type RenderableService,
  type ServiceCreateValues,
} from '../src/components/seller-service-forms';

/**
 * The service forms' logic (Phase 6-G).
 *
 * The pure half of the UI, tested without a browser, because that is where the decisions are:
 *
 *   * which of S-8's actions each state offers — the same rule the listings rows use, asserted here against
 *     the whole status vocabulary so the reuse is not taken on trust;
 *   * what a blank box means for each of the fourteen editable fields: preserve, clear, refuse, or — for the
 *     pricing model — withdraw the whole detail row;
 *   * that withdrawing the pricing model does not send the four fields that hang off it, because the database
 *     refuses that combination;
 *   * that the `fixed` model's delivery-time rule is enforced on the effective values, not on either field
 *     alone;
 *   * that an amount is displayed through the money package and the currency's own minor unit, never a
 *     divisor invented here;
 *   * that nothing is optimistic and no request carries a status, a type, an owner or an identifier.
 *
 * No React, no DOM, no network: `fetch` is a function.
 */

const SERVICE: RenderableService = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  status: 'draft',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  priceMinor: '9900',
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
  requiresBrief: true,
  scope: 'Two concepts.',
  mediaCount: 0,
};

const VALID_CREATE: ServiceCreateValues = {
  ...EMPTY_SERVICE_CREATE_VALUES,
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
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

describe('which actions a service offers', () => {
  it('lets a draft be edited and submitted, and nothing else', () => {
    expect(serviceActions('draft', true)).toEqual(['edit', 'submit']);
  });

  it('lets the live pair be archived', () => {
    expect(serviceActions('approved', true)).toEqual(['archive']);
    expect(serviceActions('active', true)).toEqual(['archive']);
  });

  it.each(['pending_review', 'sold', 'expired', 'archived', 'rejected', 'suspended', 'deleted'])(
    'offers nothing at all for %s',
    (status) => {
      expect(serviceActions(status, true)).toEqual([]);
    },
  );

  it('offers nothing whatsoever when the storefront cannot mutate', () => {
    for (const status of ['draft', 'approved', 'active', 'pending_review']) {
      expect(serviceActions(status, false), status).toEqual([]);
    }
  });

  it('has no delete among its actions, anywhere', () => {
    for (const status of ['draft', 'approved', 'active', 'archived']) {
      expect(serviceActions(status, true), status).not.toContain('delete');
    }
  });
});

describe('the render projection', () => {
  it('carries exactly the fields a seller surface shows, and no identifier', () => {
    const projected = renderableService({
      ...SERVICE,
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
        'currencyMinorUnit',
        'deliveryDays',
        'description',
        'governorate',
        'isNegotiable',
        'mediaCount',
        'priceMinor',
        'pricingModel',
        'requiresBrief',
        'revisionsIncluded',
        'scope',
        'slug',
        'status',
        'title',
      ].sort(),
    );
    const payload = JSON.stringify(projected);
    for (const field of ['sellerUserId', 'categoryId', 'listingId', 'approvedAt', 'viewCount']) {
      expect(payload, field).not.toContain(field);
    }
  });
});

describe('displaying an amount', () => {
  it('formats through the money package and the currency’s own minor unit', () => {
    expect(serviceAmount(SERVICE)).toBe('EGP 99.00');
  });

  it('formats a zero-decimal currency without inventing a decimal point', () => {
    expect(serviceAmount({ ...SERVICE, currencyMinorUnit: 0, priceMinor: '99' })).toBe('EGP 99');
  });

  it('shows nothing when there is no amount, rather than a zero', () => {
    expect(serviceAmount({ ...SERVICE, priceMinor: null })).toBeNull();
  });

  it('shows nothing rather than a broken string when the amount cannot be read', () => {
    expect(serviceAmount({ ...SERVICE, priceMinor: 'not a number' })).toBeNull();
  });
});

describe('building a creation', () => {
  it('builds the minimum valid draft: no price, no detail row, no media', () => {
    const built = buildServiceCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.priceMinor).toBeUndefined();
    expect(built.body.pricingModel).toBeUndefined();
    expect(JSON.stringify(built.body)).not.toContain('media');
  });

  it('never sends a status, a listing type, an owner or an identifier', () => {
    const built = buildServiceCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = JSON.stringify(built.body);
    for (const field of ['status', 'listingType', 'sellerUserId', 'userId', 'listingId', 'categoryId']) {
      expect(payload, field).not.toContain(field);
    }
  });

  it.each(['slug', 'title', 'description', 'categorySlug', 'currencyCode'] as const)(
    'reports a blank %s as incomplete, which is a different message from invalid',
    (field) => {
      const built = buildServiceCreate({ ...VALID_CREATE, [field]: '' });
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.incomplete).toBe(true);
    },
  );

  it.each([
    ['a delivery time', { deliveryDays: '7' }],
    ['a revision count', { revisionsIncluded: '3' }],
    ['a brief requirement', { requiresBrief: 'yes' }],
    ['a scope', { scope: 'Two concepts.' }],
  ])('refuses %s stated without a pricing model', (_name, over) => {
    const built = buildServiceCreate({ ...VALID_CREATE, ...over });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(true);
  });

  it('refuses a fixed model with no delivery time: the detail table’s own biconditional', () => {
    const built = buildServiceCreate({ ...VALID_CREATE, pricingModel: 'fixed' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(true);
  });

  it('accepts a custom model with no delivery time', () => {
    const built = buildServiceCreate({ ...VALID_CREATE, pricingModel: 'custom' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.pricingModel).toBe('custom');
    expect(built.body.deliveryDays).toBeUndefined();
  });

  it('sends the five detail fields when the model is stated', () => {
    const built = buildServiceCreate({
      ...VALID_CREATE,
      pricingModel: 'fixed',
      deliveryDays: '7',
      revisionsIncluded: '3',
      requiresBrief: 'yes',
      scope: '  Two concepts.  ',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.deliveryDays).toBe(7);
    expect(built.body.revisionsIncluded).toBe(3);
    expect(built.body.requiresBrief).toBe(true);
    expect(built.body.scope).toBe('Two concepts.');
  });

  it('sends the price as a digits-only string, and refuses anything else', () => {
    const good = buildServiceCreate({ ...VALID_CREATE, priceMinor: '9900' });
    expect(good.ok && good.body.priceMinor).toBe('9900');
    for (const price of ['99.00', '-1', 'free', '1e3']) {
      expect(buildServiceCreate({ ...VALID_CREATE, priceMinor: price }).ok, price).toBe(false);
    }
  });

  it('refuses a non-numeric delivery time or revision count', () => {
    expect(
      buildServiceCreate({ ...VALID_CREATE, pricingModel: 'fixed', deliveryDays: 'soon' }).ok,
    ).toBe(false);
    expect(
      buildServiceCreate({ ...VALID_CREATE, pricingModel: 'custom', revisionsIncluded: 'many' }).ok,
    ).toBe(false);
  });

  it('names no currency of its own: the starting value is empty', () => {
    expect(EMPTY_SERVICE_CREATE_VALUES.currencyCode).toBe('');
  });

  it('omits the optional location fields when they are blank', () => {
    const built = buildServiceCreate({ ...VALID_CREATE, governorate: '  ', city: '' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.hasOwn(built.body, 'governorate')).toBe(false);
    expect(Object.hasOwn(built.body, 'city')).toBe(false);
  });
});

describe('building an edit', () => {
  const starting = initialServiceUpdateValues(SERVICE);

  it('fills every editable field from the row, so a blank box is unambiguous', () => {
    expect(Object.keys(starting).sort()).toEqual([...SERVICE_UPDATE_FIELDS].sort());
    expect(starting.title).toBe('Logo Design');
    expect(starting.priceMinor).toBe('9900');
    expect(starting.pricingModel).toBe('fixed');
    expect(starting.deliveryDays).toBe('5');
    expect(starting.revisionsIncluded).toBe('2');
    expect(starting.requiresBrief).toBe('yes');
    expect(starting.scope).toBe('Two concepts.');
  });

  it('sends only what changed', () => {
    const built = buildServiceUpdate({ ...starting, title: 'Logo Design Pro' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({ title: 'Logo Design Pro' });
    expect(built.changed).toBe(true);
  });

  it('reports an untouched form as changing nothing', () => {
    const built = buildServiceUpdate(starting, starting);
    expect(built.ok && built.changed).toBe(false);
  });

  it.each([...CLEARABLE_SERVICE_FIELDS])('sends a blank %s as null', (field) => {
    const from = { ...starting, [field]: 'something' };
    // The delivery time can only be cleared while the model is not fixed, so move to custom for that one.
    const values =
      field === 'deliveryDays'
        ? { ...from, [field]: '', pricingModel: 'custom' }
        : { ...from, [field]: '' };
    const built = buildServiceUpdate(values, from);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body[field as keyof typeof built.body]).toBeNull();
  });

  it.each([...REQUIRED_DETAIL_FIELDS])('never sends a null %s: the column is not-null with a default', (field) => {
    const built = buildServiceUpdate({ ...starting, [field]: '' }, starting);
    // `requiresBrief` is a checkbox, so blank means false rather than null; `revisionsIncluded` is refused.
    if (field === 'requiresBrief') {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.body.requiresBrief).toBe(false);
      return;
    }
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(true);
  });

  it.each(['title', 'description', 'contentLanguage', 'currencyCode', 'countryCode'] as const)(
    'refuses a blank %s as incomplete: that column cannot be emptied',
    (field) => {
      const built = buildServiceUpdate({ ...starting, [field]: '' }, starting);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.incomplete).toBe(true);
    },
  );

  it('withdraws the detail row by sending the pricing model as null, and nothing else with it', () => {
    const built = buildServiceUpdate({ ...starting, pricingModel: '' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.body.pricingModel).toBeNull();
    // The four that hang off the model are not sent beside its withdrawal: the database refuses that pair,
    // and the boxes still holding their old values are simply not part of the request.
    for (const field of ['deliveryDays', 'revisionsIncluded', 'requiresBrief', 'scope'] as const) {
      expect(Object.hasOwn(built.body, field), field).toBe(false);
    }
  });

  it('does not send a pricing model that was already absent', () => {
    const bare = initialServiceUpdateValues({ ...SERVICE, pricingModel: null, deliveryDays: null });
    const built = buildServiceUpdate({ ...bare, title: 'Renamed' }, bare);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.hasOwn(built.body, 'pricingModel')).toBe(false);
  });

  it('refuses leaving a fixed model with no delivery time, whichever field moved', () => {
    // Clearing the time while the model stays fixed.
    expect(buildServiceUpdate({ ...starting, deliveryDays: '' }, starting).ok).toBe(false);
    // Moving to fixed on a service that has no time.
    const custom = initialServiceUpdateValues({
      ...SERVICE,
      pricingModel: 'custom',
      deliveryDays: null,
    });
    expect(buildServiceUpdate({ ...custom, pricingModel: 'fixed' }, custom).ok).toBe(false);
  });

  it('allows moving to a custom model and clearing the delivery time together', () => {
    const built = buildServiceUpdate({ ...starting, pricingModel: 'custom', deliveryDays: '' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.pricingModel).toBe('custom');
    expect(built.body.deliveryDays).toBeNull();
  });

  it('treats the two checkboxes as booleans, sent only when they moved', () => {
    const on = buildServiceUpdate({ ...starting, isNegotiable: 'yes' }, starting);
    expect(on.ok && on.body.isNegotiable).toBe(true);

    const off = buildServiceUpdate({ ...starting, requiresBrief: '' }, starting);
    expect(off.ok && off.body.requiresBrief).toBe(false);

    const unchanged = buildServiceUpdate(starting, starting);
    expect(unchanged.ok && Object.hasOwn(unchanged.body, 'isNegotiable')).toBe(false);
  });

  it('refuses a price, delivery time or revision count that is not a whole number', () => {
    expect(buildServiceUpdate({ ...starting, priceMinor: '99.00' }, starting).ok).toBe(false);
    expect(buildServiceUpdate({ ...starting, deliveryDays: '7.5' }, starting).ok).toBe(false);
    expect(buildServiceUpdate({ ...starting, revisionsIncluded: 'many' }, starting).ok).toBe(false);
  });

  it('can never send a slug, a type, a category or a status', () => {
    const built = buildServiceUpdate({ ...starting, title: 'Renamed' }, starting);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const payload = JSON.stringify(built.body);
    for (const field of ['slug', 'listingType', 'categorySlug', 'status', 'submittedAt']) {
      expect(payload, field).not.toContain(field);
    }
  });
});

describe('sending a write', () => {
  it('posts a creation same-origin to the service route', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const built = buildServiceCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const outcome = await submitServiceCreate(
      built.body,
      recorder(201, { listing: { slug: 'logo-design', status: 'draft' } }, seen),
    );

    expect(outcome).toEqual({ kind: 'ok', slug: 'logo-design', status: 'draft' });
    expect(seen[0]?.url).toBe('/api/sellers/me/services');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.credentials).toBe('same-origin');
  });

  it('patches an edit at the service’s own address, percent-encoded', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    await submitServiceUpdate(
      'logo design/../x',
      { title: 'Renamed Svc' },
      recorder(200, { listing: { slug: 'a', status: 'draft' } }, seen),
    );
    expect(seen[0]?.url).toBe('/api/sellers/me/services/logo%20design%2F..%2Fx');
    expect(seen[0]?.init?.method).toBe('PATCH');
  });

  it('tells the conflicts apart, because the remedies differ', async () => {
    const at = async (code: string) =>
      submitServiceUpdate('logo-design', {}, responder(409, { code, detail: 'refused' }));

    expect((await at('SELLER_LISTING_NOT_EDITABLE')).kind).toBe('not_editable');
    expect((await at('SELLER_PROFILE_NOT_EDITABLE')).kind).toBe('not_editable');
    expect((await at('SELLER_LISTING_SLUG_TAKEN')).kind).toBe('slug_taken');
    expect((await at('SELLER_LISTING_INCOMPLETE')).kind).toBe('incomplete');
    expect((await at('SOMETHING_NEW')).kind).toBe('unavailable');
  });

  it('reports the other refusals without guessing', async () => {
    expect((await submitServiceUpdate('logo-design', {}, responder(401, {}))).kind).toBe('unauthenticated');
    expect((await submitServiceUpdate('logo-design', {}, responder(404, {}))).kind).toBe('not_found');
    expect((await submitServiceUpdate('logo-design', {}, responder(400, {}))).kind).toBe('invalid');
    expect((await submitServiceUpdate('logo-design', {}, responder(429, {}))).kind).toBe('unavailable');
  });

  it('refuses a success body that has drifted rather than rendering a guess', async () => {
    expect((await submitServiceUpdate('logo-design', {}, responder(200, { listing: {} }))).kind).toBe(
      'unavailable',
    );
    expect((await submitServiceUpdate('logo-design', {}, responder(200, 'not json'))).kind).toBe(
      'unavailable',
    );
  });

  it('compares the success status exactly: a 200 where 201 is contracted is not a success', async () => {
    const built = buildServiceCreate(VALID_CREATE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const outcome = await submitServiceCreate(
      built.body,
      responder(200, { listing: { slug: 'logo-design', status: 'draft' } }),
    );
    expect(outcome.kind).toBe('unavailable');
  });

  it('reports an unreachable origin as unavailable rather than throwing at a form', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await submitServiceUpdate('logo-design', {}, failing)).kind).toBe('unavailable');
  });
});
