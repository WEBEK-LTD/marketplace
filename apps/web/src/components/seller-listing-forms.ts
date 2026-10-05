import {
  SellerListingCreateRequestSchema,
  SellerListingMutationResponseSchema,
  SellerListingUpdateRequestSchema,
  type SellerListing,
  type SellerListingCreateRequest,
  type SellerListingUpdateRequest,
} from '@repo/contracts';

/**
 * The listing forms' logic, with no React in it (Phase 6-F).
 *
 * A plain module for the reason 6-C's and 6-D's are: what a form sends, which actions a listing offers and
 * which sentence a refusal becomes are all decidable without a browser, so they are decided in functions a
 * test can call exactly. The components around them hold state and render.
 *
 * **The blank-box rule is simpler here than in 6-D, and that is not an accident.** The listings readback
 * carries all nine editable fields, so an edit form can pre-fill every one of them — which means a blank box
 * unambiguously says "clear this", and it is sent as `null` for the three columns that may be empty and
 * refused client-side for the six that may not. 6-D had to treat a blank box two different ways only because
 * the identity projection it was allowed to read could not show six of its fields.
 *
 * **The price is in minor units.** The seller listing contract carries a currency code but not that
 * currency's minor-unit count, and 6-F adds no read to fetch one, so nothing here divides or multiplies by a
 * figure it would have to assume. The field is the stored integer and the copy says so. A later increment
 * that carries the minor unit can offer a decimal box; inventing the conversion now would mean a form that
 * silently mis-prices a listing the day a zero-decimal currency is enabled.
 *
 * **No currency is named anywhere in this module, and none is defaulted.** Owner decision E3 forbids a
 * currency literal outside migrations, seeds and tests, and it is right to: a code written into a form is a
 * code that keeps being right until the day the enabled set changes, and then is silently wrong. The currency
 * a form offers is therefore data the page passed in — the seller's own listings say which currencies they
 * already price in — and when a seller has no listings yet the form asks for the code instead of guessing it.
 *
 * **Nothing here is optimistic.** Every submit function reports what the server said, validated against the
 * shared contract and projected onto a narrow render type — never a copy of what was typed, and never an
 * invented status.
 */

/** The twelve fields a creation form holds. Every one is a string, because that is what an input holds. */
export const LISTING_CREATE_FIELDS = [
  'slug',
  'title',
  'description',
  'listingTypeCode',
  'categorySlug',
  'contentLanguage',
  'currencyCode',
  'countryCode',
  'priceMinor',
  'isNegotiable',
  'governorate',
  'city',
] as const;

export type ListingCreateField = (typeof LISTING_CREATE_FIELDS)[number];
export type ListingCreateValues = Readonly<Record<ListingCreateField, string>>;

/** The nine an edit form holds. No slug, no type, no category: none of them is editable. */
export const LISTING_UPDATE_FIELDS = [
  'title',
  'description',
  'priceMinor',
  'isNegotiable',
  'contentLanguage',
  'currencyCode',
  'countryCode',
  'governorate',
  'city',
] as const;

export type ListingUpdateField = (typeof LISTING_UPDATE_FIELDS)[number];
export type ListingUpdateValues = Readonly<Record<ListingUpdateField, string>>;

/** The three the listings table allows to be empty, and therefore the three a blank box can clear. */
export const CLEARABLE_UPDATE_FIELDS = ['priceMinor', 'governorate', 'city'] as const;

export const EMPTY_LISTING_CREATE_VALUES: ListingCreateValues = Object.freeze({
  slug: '',
  title: '',
  description: '',
  listingTypeCode: 'product',
  categorySlug: '',
  contentLanguage: 'en',
  currencyCode: '',
  countryCode: 'EG',
  priceMinor: '',
  isNegotiable: '',
  governorate: '',
  city: '',
});

/**
 * The listing as a seller surface renders it: a narrowed render type, built field by field.
 *
 * Not the contract object, even though the fields match today. Written out so that a field added to the
 * contract later cannot arrive in a client component by structural typing — and because a client component's
 * props become part of the RSC payload, so what is listed here is exactly what a browser receives.
 */
export interface RenderableListing {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly listingTypeCode: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly priceMinor: number | null;
  readonly isNegotiable: boolean;
  readonly contentLanguage: string;
  readonly countryCode: string;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly mediaCount: number;
}

/** The projection, applied to one validated contract row. Explicit, so nothing travels by accident. */
export function renderableListing(listing: SellerListing): RenderableListing {
  return {
    slug: listing.slug,
    title: listing.title,
    description: listing.description,
    listingTypeCode: listing.listingTypeCode,
    categorySlug: listing.categorySlug,
    status: listing.status,
    currencyCode: listing.currencyCode,
    priceMinor: listing.priceMinor,
    isNegotiable: listing.isNegotiable,
    contentLanguage: listing.contentLanguage,
    countryCode: listing.countryCode,
    governorate: listing.governorate,
    city: listing.city,
    mediaCount: listing.mediaCount,
  };
}

/** The starting state of an edit form: every editable field, as the server last reported it. */
export function initialListingUpdateValues(listing: RenderableListing): ListingUpdateValues {
  return {
    title: listing.title,
    description: listing.description,
    priceMinor: listing.priceMinor === null ? '' : String(listing.priceMinor),
    isNegotiable: listing.isNegotiable ? 'yes' : '',
    contentLanguage: listing.contentLanguage,
    currencyCode: listing.currencyCode,
    countryCode: listing.countryCode,
    governorate: listing.governorate ?? '',
    city: listing.city ?? '',
  };
}

/**
 * Which of S-8's actions a listing offers, and to whom.
 *
 * The single place this question is answered, so the buttons a page renders and the states the API accepts
 * cannot drift apart in the parts of the app a person actually sees. It is the *surface* agreeing with the
 * database, never deciding for it: every one of these is checked again in `app_private`, and a listing whose
 * state changed between a page render and a click is refused there.
 *
 * `draft` may be edited and submitted. The live pair — `approved` and `active`, which is the listings
 * schema's own notion of purchasable — may be archived. Everything else offers nothing: a submitted listing
 * is somebody else's to act on until they do, and a sold, expired, rejected, suspended or already archived
 * listing is not a seller's to move at all. There is no delete, here or anywhere.
 *
 * A storefront that cannot mutate offers nothing whatsoever, whatever its listings say — which is why the
 * seller's own state is a parameter rather than something inferred from a listing.
 */
export const LISTING_ACTIONS = ['edit', 'submit', 'archive'] as const;
export type ListingAction = (typeof LISTING_ACTIONS)[number];

export function listingActions(status: string, sellerCanMutate: boolean): readonly ListingAction[] {
  if (!sellerCanMutate) return [];
  if (status === 'draft') return ['edit', 'submit'];
  if (status === 'approved' || status === 'active') return ['archive'];
  return [];
}

/** Whether a storefront in this state receives any mutation authorization at all. */
export function sellerCanMutate(status: string): boolean {
  return status === 'pending' || status === 'active';
}

export type ListingCreateBuild =
  | { readonly ok: true; readonly body: SellerListingCreateRequest }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body a creation sends, or why it cannot be built.
 *
 * The required fields are checked first, because "you left this blank" is a different message from "this is
 * not a valid value". Everything else is the shared contract's own check, applied here so a mistyped address
 * costs no round trip — and applied again upstream, and again in the database, either of which may still
 * refuse a value this accepted.
 */
export function buildListingCreate(values: ListingCreateValues): ListingCreateBuild {
  const required: readonly ListingCreateField[] = [
    'slug',
    'title',
    'description',
    'listingTypeCode',
    'categorySlug',
    'contentLanguage',
    'currencyCode',
    'countryCode',
  ];
  for (const field of required) {
    if (values[field].trim() === '') return { ok: false, incomplete: true };
  }

  const price = values.priceMinor.trim();
  const candidate: Record<string, unknown> = {
    slug: values.slug.trim(),
    title: values.title,
    description: values.description,
    listingTypeCode: values.listingTypeCode.trim(),
    categorySlug: values.categorySlug.trim(),
    contentLanguage: values.contentLanguage.trim(),
    currencyCode: values.currencyCode.trim(),
    countryCode: values.countryCode.trim(),
    isNegotiable: values.isNegotiable !== '',
  };
  // A blank price is a draft with no price, which the schema permits and S-9 expects. A price that is not a
  // whole number is a refusal here rather than something coerced into one.
  if (price !== '') {
    if (!/^\d+$/.test(price)) return { ok: false, incomplete: false };
    candidate['priceMinor'] = Number.parseInt(price, 10);
  }
  const governorate = values.governorate.trim();
  const city = values.city.trim();
  if (governorate !== '') candidate['governorate'] = governorate;
  if (city !== '') candidate['city'] = city;

  const parsed = SellerListingCreateRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, incomplete: false };
}

export type ListingUpdateBuild =
  | { readonly ok: true; readonly body: SellerListingUpdateRequest; readonly changed: boolean }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body an edit sends, or why it cannot be built.
 *
 * Only what changed is sent, so an edit to one field is a request about one field — which is what makes the
 * partial-update contract meaningful rather than a formality. A blank box on one of the three clearable
 * fields is sent as `null`; a blank box on any of the other six is a refusal, because those columns cannot be
 * emptied and a request that tried would be refused upstream anyway.
 *
 * `changed: false` means the person pressed save without altering anything: a valid request that would be a
 * round trip for nothing.
 */
export function buildListingUpdate(
  values: ListingUpdateValues,
  starting: ListingUpdateValues,
): ListingUpdateBuild {
  const candidate: Record<string, unknown> = {};

  for (const field of LISTING_UPDATE_FIELDS) {
    const typed = values[field].trim();
    const was = starting[field].trim();
    const clearable = (CLEARABLE_UPDATE_FIELDS as readonly string[]).includes(field);

    if (field === 'isNegotiable') {
      const now = values[field] !== '';
      if (now !== (starting[field] !== '')) candidate[field] = now;
      continue;
    }

    if (typed === '') {
      if (!clearable) return { ok: false, incomplete: true };
      // Already empty: there is nothing to say about it.
      if (was !== '') candidate[field] = null;
      continue;
    }
    if (typed === was) continue;

    if (field === 'priceMinor') {
      if (!/^\d+$/.test(typed)) return { ok: false, incomplete: false };
      candidate[field] = Number.parseInt(typed, 10);
      continue;
    }
    candidate[field] = typed;
  }

  const changed = Object.keys(candidate).length > 0;
  const parsed = SellerListingUpdateRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data, changed } : { ok: false, incomplete: false };
}

/** What the server said about one write. `slug` and `status` are all any of the four answer with. */
export type ListingWriteOutcome =
  | { readonly kind: 'ok'; readonly slug: string; readonly status: string }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'slug_taken' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** The problem code, if the body is a problem document. Anything else reads as no code at all. */
function problemCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * One write against the BFF route on this origin, and what came back.
 *
 * Same-origin, so the `__Host-mp_access` cookie travels and no token is ever handled here. The success body
 * is validated against the shared contract and only its two fields are reported, so what a surface then
 * shows is what the database wrote — never an optimistic copy of what was clicked.
 *
 * The 409 codes are told apart, because the three mean different things a seller can act on: a state this
 * surface does not write, an address that is unavailable, and a draft that needs a price. A 409 carrying a
 * code this function does not know is reported as unavailable rather than guessed at.
 */
// Exported, as of 6-G, because the seller services surface sends its two writes through exactly this
// function: the refusal mapping below is the one a seller surface needs, and a second copy of it would be a
// second thing to keep in step. Nothing about the function itself changed.
export async function listingWrite(
  path: string,
  method: 'POST' | 'PATCH',
  expected: 200 | 201,
  body: unknown | null,
  fetcher: typeof fetch,
): Promise<ListingWriteOutcome> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      ...(body === null
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');

  if (response.status === expected) {
    let parsed: ReturnType<typeof SellerListingMutationResponseSchema.safeParse>;
    try {
      parsed = SellerListingMutationResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return { kind: 'unavailable' };
    }
    if (!parsed.success) return { kind: 'unavailable' };
    return { kind: 'ok', slug: parsed.data.listing.slug, status: parsed.data.listing.status };
  }

  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 404) return { kind: 'not_found' };
  if (response.status === 400) return { kind: 'invalid' };
  if (response.status === 409) {
    const code = problemCode(text);
    if (code === 'SELLER_LISTING_NOT_EDITABLE' || code === 'SELLER_PROFILE_NOT_EDITABLE') {
      return { kind: 'not_editable' };
    }
    if (code === 'SELLER_LISTING_SLUG_TAKEN') return { kind: 'slug_taken' };
    if (code === 'SELLER_LISTING_INCOMPLETE') return { kind: 'incomplete' };
    return { kind: 'unavailable' };
  }
  // A throttled write is not invalid information, so it does not get the "invalid" sentence.
  return { kind: 'unavailable' };
}

export async function submitListingCreate(
  body: SellerListingCreateRequest,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/listings',
): Promise<ListingWriteOutcome> {
  return listingWrite(path, 'POST', 201, body, fetcher);
}

export async function submitListingUpdate(
  slug: string,
  body: SellerListingUpdateRequest,
  fetcher: typeof fetch = fetch,
  base = '/api/sellers/me/listings',
): Promise<ListingWriteOutcome> {
  return listingWrite(`${base}/${encodeURIComponent(slug)}`, 'PATCH', 200, body, fetcher);
}

/** No body at all: a status a caller could send would be a status a caller could choose. */
export async function submitListingForReview(
  slug: string,
  fetcher: typeof fetch = fetch,
  base = '/api/sellers/me/listings',
): Promise<ListingWriteOutcome> {
  return listingWrite(`${base}/${encodeURIComponent(slug)}/submission`, 'POST', 200, null, fetcher);
}

/** Archival, not deletion. There is no delete anywhere on this surface. */
export async function archiveListing(
  slug: string,
  fetcher: typeof fetch = fetch,
  base = '/api/sellers/me/listings',
): Promise<ListingWriteOutcome> {
  return listingWrite(`${base}/${encodeURIComponent(slug)}/archive`, 'POST', 200, null, fetcher);
}
