import {
  SellerServiceCreateRequestSchema,
  SellerServiceUpdateRequestSchema,
  type SellerService,
  type SellerServiceCreateRequest,
  type SellerServiceUpdateRequest,
} from '@repo/contracts';
import { formatListingAmount } from './listing-price';
import {
  listingActions,
  listingWrite,
  type ListingAction,
  type ListingWriteOutcome,
} from './seller-listing-forms';

/**
 * The service forms' logic, with no React in it (Phase 6-G).
 *
 * A plain module for the reason 6-C's, 6-D's and 6-F's are: what a form sends, what a blank box means and
 * which sentence a refusal becomes are decided in functions a test can call exactly.
 *
 * **What is reused rather than rebuilt.** Which actions a state offers is {@link listingActions} — the same
 * pure function 6-F's rows use, because a service is a listing and the rule is the same one. Submitting and
 * archiving are 6-F's own senders, aimed at the listing routes. Displaying an amount is
 * {@link formatListingAmount}, the money reader 4-B already established, which goes through `@repo/money`
 * with the currency's own minor unit and converts nothing.
 *
 * **Three states per detail field, and a fourth for the pricing model.** Absent preserves; `null` clears
 * `deliveryDays` and `scope`, which the detail table allows to be empty; and `pricingModel: null` withdraws
 * the whole detail row, because the other four hang off it. `revisionsIncluded` and `requiresBrief` are
 * declared `not null` with defaults, so a blank box on either is refused rather than sent as null.
 *
 * **The price is entered in the currency's minor unit, and displayed as a decimal.** The readback carries
 * `currencyMinorUnit`, so the *display* goes through the money package and is exact. The *input* stays an
 * integer in minor units, because a decimal box needs the minor unit before the currency is known — which it
 * is not when a seller with no services yet creates their first one — and a form that behaved one way there
 * and another way here would be worse than one that behaves the same way everywhere. No divisor is assumed
 * anywhere, and no currency code appears in this file: owner decision E3.
 */

/** The seventeen fields a creation form holds. Every one is a string, because that is what an input holds. */
export const SERVICE_CREATE_FIELDS = [
  'slug',
  'title',
  'description',
  'categorySlug',
  'contentLanguage',
  'currencyCode',
  'countryCode',
  'priceMinor',
  'isNegotiable',
  'governorate',
  'city',
  'pricingModel',
  'deliveryDays',
  'revisionsIncluded',
  'requiresBrief',
  'scope',
] as const;

export type ServiceCreateField = (typeof SERVICE_CREATE_FIELDS)[number];
export type ServiceCreateValues = Readonly<Record<ServiceCreateField, string>>;

/** The fourteen an edit form holds. No slug, no type, no category: none of them is editable. */
export const SERVICE_UPDATE_FIELDS = [
  'title',
  'description',
  'priceMinor',
  'isNegotiable',
  'contentLanguage',
  'currencyCode',
  'countryCode',
  'governorate',
  'city',
  'pricingModel',
  'deliveryDays',
  'revisionsIncluded',
  'requiresBrief',
  'scope',
] as const;

export type ServiceUpdateField = (typeof SERVICE_UPDATE_FIELDS)[number];
export type ServiceUpdateValues = Readonly<Record<ServiceUpdateField, string>>;

/** The four a blank box may clear, because their columns are nullable or their row can be withdrawn. */
export const CLEARABLE_SERVICE_FIELDS = [
  'priceMinor',
  'governorate',
  'city',
  'deliveryDays',
  'scope',
] as const;

/** The two the detail table declares `not null` with a default: changeable, never emptied. */
export const REQUIRED_DETAIL_FIELDS = ['revisionsIncluded', 'requiresBrief'] as const;

export const EMPTY_SERVICE_CREATE_VALUES: ServiceCreateValues = Object.freeze({
  slug: '',
  title: '',
  description: '',
  categorySlug: '',
  contentLanguage: 'en',
  currencyCode: '',
  countryCode: 'EG',
  priceMinor: '',
  isNegotiable: '',
  governorate: '',
  city: '',
  pricingModel: '',
  deliveryDays: '',
  revisionsIncluded: '',
  requiresBrief: '',
  scope: '',
});

/**
 * The service as a seller surface renders it: a narrowed render type, built field by field.
 *
 * Not the contract object, even though the fields match today. A client component's props become part of the
 * RSC payload, so what is listed here is exactly what a browser receives — and written out explicitly so a
 * field added to the contract later cannot arrive there by structural typing.
 */
export interface RenderableService {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly priceMinor: string | null;
  readonly isNegotiable: boolean;
  readonly contentLanguage: string;
  readonly countryCode: string;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly pricingModel: string | null;
  readonly deliveryDays: number | null;
  readonly revisionsIncluded: number | null;
  readonly requiresBrief: boolean | null;
  readonly scope: string | null;
  readonly mediaCount: number;
}

/** The projection, applied to one validated contract row. Explicit, so nothing travels by accident. */
export function renderableService(service: SellerService): RenderableService {
  return {
    slug: service.slug,
    title: service.title,
    description: service.description,
    categorySlug: service.categorySlug,
    status: service.status,
    currencyCode: service.currencyCode,
    currencyMinorUnit: service.currencyMinorUnit,
    priceMinor: service.priceMinor,
    isNegotiable: service.isNegotiable,
    contentLanguage: service.contentLanguage,
    countryCode: service.countryCode,
    governorate: service.governorate,
    city: service.city,
    pricingModel: service.pricingModel,
    deliveryDays: service.deliveryDays,
    revisionsIncluded: service.revisionsIncluded,
    requiresBrief: service.requiresBrief,
    scope: service.scope,
    mediaCount: service.mediaCount,
  };
}

/** The amount as a person reads it, through the money package. Null when there is none to show. */
export function serviceAmount(service: RenderableService): string | null {
  return formatListingAmount(service.priceMinor, service.currencyCode, service.currencyMinorUnit);
}

/** The starting state of an edit form: every editable field, as the server last reported it. */
export function initialServiceUpdateValues(service: RenderableService): ServiceUpdateValues {
  return {
    title: service.title,
    description: service.description,
    priceMinor: service.priceMinor ?? '',
    isNegotiable: service.isNegotiable ? 'yes' : '',
    contentLanguage: service.contentLanguage,
    currencyCode: service.currencyCode,
    countryCode: service.countryCode,
    governorate: service.governorate ?? '',
    city: service.city ?? '',
    pricingModel: service.pricingModel ?? '',
    deliveryDays: service.deliveryDays === null ? '' : String(service.deliveryDays),
    revisionsIncluded: service.revisionsIncluded === null ? '' : String(service.revisionsIncluded),
    requiresBrief: service.requiresBrief === true ? 'yes' : '',
    scope: service.scope ?? '',
  };
}

/**
 * Which of S-8's actions a service offers, and to whom.
 *
 * 6-F's function, called rather than copied, because a service is a listing and this is the same question
 * about the same status column. `draft` may be edited and submitted; the live pair may be archived;
 * everything else offers nothing; and a storefront that cannot mutate offers nothing at all.
 */
export function serviceActions(status: string, sellerCanMutate: boolean): readonly ListingAction[] {
  return listingActions(status, sellerCanMutate);
}

/** A whole non-negative number, written as digits and nothing else. */
function digits(value: string): boolean {
  return /^\d+$/.test(value);
}

export type ServiceCreateBuild =
  | { readonly ok: true; readonly body: SellerServiceCreateRequest }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body a creation sends, or why it cannot be built.
 *
 * The required fields are checked first, because "you left this blank" is a different message from "this is
 * not a valid value". Then the one rule that is this increment's own: nothing about pricing may be stated
 * without the pricing model it belongs to, and a `fixed` model needs a delivery time. Both are the
 * database's rules, applied here so a mistake costs no round trip — and applied again upstream and again in
 * the database, either of which may still refuse a value this accepted.
 */
export function buildServiceCreate(values: ServiceCreateValues): ServiceCreateBuild {
  const required: readonly ServiceCreateField[] = [
    'slug',
    'title',
    'description',
    'categorySlug',
    'contentLanguage',
    'currencyCode',
    'countryCode',
  ];
  for (const field of required) {
    if (values[field].trim() === '') return { ok: false, incomplete: true };
  }

  const model = values.pricingModel.trim();
  const days = values.deliveryDays.trim();
  const revisions = values.revisionsIncluded.trim();
  const brief = values.requiresBrief !== '';
  const scope = values.scope.trim();

  // Nothing may be stated without the model it belongs to.
  if (model === '' && (days !== '' || revisions !== '' || brief || scope !== '')) {
    return { ok: false, incomplete: true };
  }
  // A fixed-price service needs a delivery time: the detail table's own biconditional.
  if (model === 'fixed' && days === '') return { ok: false, incomplete: true };

  const candidate: Record<string, unknown> = {
    slug: values.slug.trim(),
    title: values.title,
    description: values.description,
    categorySlug: values.categorySlug.trim(),
    contentLanguage: values.contentLanguage.trim(),
    currencyCode: values.currencyCode.trim(),
    countryCode: values.countryCode.trim(),
    isNegotiable: values.isNegotiable !== '',
  };

  const price = values.priceMinor.trim();
  if (price !== '') {
    if (!digits(price)) return { ok: false, incomplete: false };
    candidate['priceMinor'] = price;
  }
  const governorate = values.governorate.trim();
  const city = values.city.trim();
  if (governorate !== '') candidate['governorate'] = governorate;
  if (city !== '') candidate['city'] = city;

  if (model !== '') {
    candidate['pricingModel'] = model;
    if (days !== '') {
      if (!digits(days)) return { ok: false, incomplete: false };
      candidate['deliveryDays'] = Number.parseInt(days, 10);
    }
    if (revisions !== '') {
      if (!digits(revisions)) return { ok: false, incomplete: false };
      candidate['revisionsIncluded'] = Number.parseInt(revisions, 10);
    }
    if (brief) candidate['requiresBrief'] = true;
    if (scope !== '') candidate['scope'] = scope;
  }

  const parsed = SellerServiceCreateRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, incomplete: false };
}

export type ServiceUpdateBuild =
  | { readonly ok: true; readonly body: SellerServiceUpdateRequest; readonly changed: boolean }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body an edit sends, or why it cannot be built.
 *
 * Only what changed is sent, so an edit to one field is a request about one field. A blank box on one of the
 * clearable fields becomes `null`; a blank box on any other is a refusal, because those columns cannot be
 * emptied.
 *
 * Clearing the pricing model is the one place a blank box means more than an empty column: it withdraws the
 * detail row. So when the model is being withdrawn the other four detail fields are not sent at all — they
 * are about to cease to exist, and sending one alongside the withdrawal is the contradiction the database
 * refuses. Whatever is still displayed in those boxes is simply not part of the request.
 */
export function buildServiceUpdate(
  values: ServiceUpdateValues,
  starting: ServiceUpdateValues,
): ServiceUpdateBuild {
  const candidate: Record<string, unknown> = {};
  const withdrawingModel = values.pricingModel.trim() === '' && starting.pricingModel.trim() !== '';

  for (const field of SERVICE_UPDATE_FIELDS) {
    const typed = values[field].trim();
    const was = starting[field].trim();
    const clearable = (CLEARABLE_SERVICE_FIELDS as readonly string[]).includes(field);

    // The four that hang off the pricing model go with it, and are not sent beside its withdrawal.
    if (withdrawingModel && field !== 'pricingModel') {
      if (field === 'deliveryDays' || field === 'revisionsIncluded' || field === 'requiresBrief'
          || field === 'scope') {
        continue;
      }
    }

    if (field === 'isNegotiable' || field === 'requiresBrief') {
      const now = values[field] !== '';
      if (now !== (starting[field] !== '')) candidate[field] = now;
      continue;
    }

    if (typed === '') {
      if (field === 'pricingModel') {
        // Already absent, so there is nothing to withdraw.
        if (was !== '') candidate[field] = null;
        continue;
      }
      if (!clearable) return { ok: false, incomplete: true };
      if (was !== '') candidate[field] = null;
      continue;
    }
    if (typed === was) continue;

    if (field === 'priceMinor') {
      if (!digits(typed)) return { ok: false, incomplete: false };
      candidate[field] = typed;
      continue;
    }
    if (field === 'deliveryDays' || field === 'revisionsIncluded') {
      if (!digits(typed)) return { ok: false, incomplete: false };
      candidate[field] = Number.parseInt(typed, 10);
      continue;
    }
    candidate[field] = typed;
  }

  // A fixed-price service must still have a delivery time once this edit lands.
  const effectiveModel =
    candidate['pricingModel'] === undefined
      ? starting.pricingModel.trim()
      : ((candidate['pricingModel'] as string | null) ?? '');
  const effectiveDays =
    candidate['deliveryDays'] === undefined
      ? starting.deliveryDays.trim()
      : candidate['deliveryDays'] === null
        ? ''
        : String(candidate['deliveryDays']);
  if (effectiveModel === 'fixed' && effectiveDays === '') return { ok: false, incomplete: true };

  const changed = Object.keys(candidate).length > 0;
  const parsed = SellerServiceUpdateRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data, changed } : { ok: false, incomplete: false };
}

export type { ListingAction as ServiceAction } from './seller-listing-forms';
export type { ListingWriteOutcome as ServiceWriteOutcome } from './seller-listing-forms';

/**
 * 6-F's senders, reached through one door rather than reimplemented.
 *
 * `submitListingForReview` and `archiveListing` post to the *listing* routes, which is correct: those move
 * the same `listings` row, and the API's submitter is already service-aware. `listingWrite` carries the
 * refusal mapping every seller write needs — the three distinct 409 codes, the exact success status, the
 * validated body — so the two service writes below are the same sender aimed at the service routes.
 */
export { archiveListing, submitListingForReview } from './seller-listing-forms';

export function submitServiceCreate(
  body: SellerServiceCreateRequest,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/services',
): Promise<ListingWriteOutcome> {
  return listingWrite(path, 'POST', 201, body, fetcher);
}

export function submitServiceUpdate(
  slug: string,
  body: SellerServiceUpdateRequest,
  fetcher: typeof fetch = fetch,
  base = '/api/sellers/me/services',
): Promise<ListingWriteOutcome> {
  return listingWrite(`${base}/${encodeURIComponent(slug)}`, 'PATCH', 200, body, fetcher);
}
