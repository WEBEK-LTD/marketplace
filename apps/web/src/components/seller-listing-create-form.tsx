'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  EMPTY_LISTING_CREATE_VALUES,
  buildListingCreate,
  submitListingCreate,
  type ListingCreateField,
  type ListingCreateValues,
} from './seller-listing-forms';

/**
 * The create-a-draft form (Phase 6-F).
 *
 * **What crosses the server/client boundary.** Copy, and a list of `{ slug, name }` category pairs. The
 * category tree the server reads also carries a uuid per node; it is projected away on the server, so no
 * identifier of any kind appears in this component's props and therefore none appears in the RSC payload.
 * No seller, no account, no token, no status.
 *
 * **The server is authoritative.** Every check here is the shared contract's own, applied so a mistyped
 * address costs no round trip. Each is applied again in the API and again in the database, either of which
 * may still refuse a value this form accepted — a category that does not match the chosen listing type, for
 * instance, which the public tree gives this form no way to know.
 *
 * **A failure never clears the form.** The values live in one state object no failure path touches, so
 * somebody whose address was taken keeps the description they had just written.
 *
 * **No optimistic write.** On success the route is refreshed so the surrounding page re-reads the listings
 * from the database; nothing here adds a row to a list on the strength of having asked for one.
 */

export interface SellerListingCreateLabels {
  readonly create: string;
  readonly slug: string;
  readonly slugPermanent: string;
  readonly titleField: string;
  readonly description: string;
  readonly listingType: string;
  readonly typeProduct: string;
  readonly typeService: string;
  readonly category: string;
  readonly categoryHint: string;
  readonly language: string;
  readonly currency: string;
  readonly currencyHint: string;
  readonly country: string;
  readonly price: string;
  readonly priceHint: string;
  readonly negotiable: string;
  readonly governorate: string;
  readonly city: string;
  readonly createSubmit: string;
  readonly creating: string;
  readonly created: string;
  readonly errorInvalid: string;
  readonly errorSlugTaken: string;
  readonly errorNotEditable: string;
  readonly errorUnavailable: string;
}

/** A category as this form may see it: a public address and a name. No identifier. */
export interface RenderableCategory {
  readonly slug: string;
  readonly name: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';

/** The two interface locales, as 6-C and 6-D render them. `public.locales` remains the authority. */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

/** Egypt is the only marketplace-enabled country in V1 (D17), and the code is what 6-B already shows. */
const COUNTRIES: readonly string[] = ['EG'];

export function SellerListingCreateForm({
  labels,
  categories,
  currencies,
}: {
  readonly labels: SellerListingCreateLabels;
  readonly categories: readonly RenderableCategory[];
  /**
   * The currencies this seller already prices in, read off their own listings. Empty for a seller with no
   * listings yet, and then the form asks for a code rather than naming one — see the note in
   * `seller-listing-forms.ts` about owner decision E3.
   */
  readonly currencies: readonly string[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<ListingCreateValues>(() => ({
    ...EMPTY_LISTING_CREATE_VALUES,
    currencyCode: currencies[0] ?? '',
  }));
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [pending, setPending] = useState(false);

  function set(field: ListingCreateField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setCreated(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setCreated(false);

    const built = buildListingCreate(values);
    if (!built.ok) {
      setMessage(labels.errorInvalid);
      return;
    }

    setPending(true);
    try {
      const outcome = await submitListingCreate(built.body);
      if (outcome.kind === 'ok') {
        setCreated(true);
        setValues({ ...EMPTY_LISTING_CREATE_VALUES, currencyCode: currencies[0] ?? '' });
        // The page re-reads the listings on the server, so what appears afterwards is what is stored.
        router.refresh();
        return;
      }
      if (outcome.kind === 'slug_taken') setMessage(labels.errorSlugTaken);
      else if (outcome.kind === 'invalid') setMessage(labels.errorInvalid);
      else if (outcome.kind === 'not_editable') setMessage(labels.errorNotEditable);
      else setMessage(labels.errorUnavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="seller-listing-create-heading" className="mt-10 max-w-xl">
      <h2 id="seller-listing-create-heading" className="text-lg font-semibold text-ink-strong">
        {labels.create}
      </h2>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <div>
          <label htmlFor="listing-slug" className={LABEL_CLASS}>
            {labels.slug}
          </label>
          <input
            id="listing-slug"
            name="slug"
            type="text"
            required
            value={values.slug}
            onChange={(event) => set('slug', event.target.value)}
            className={FIELD_CLASS}
          />
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.slugPermanent}</p>
        </div>

        <div>
          <label htmlFor="listing-title" className={LABEL_CLASS}>
            {labels.titleField}
          </label>
          <input
            id="listing-title"
            name="title"
            type="text"
            required
            maxLength={140}
            value={values.title}
            onChange={(event) => set('title', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="listing-description" className={LABEL_CLASS}>
            {labels.description}
          </label>
          <textarea
            id="listing-description"
            name="description"
            required
            rows={5}
            maxLength={20000}
            value={values.description}
            onChange={(event) => set('description', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="listing-type" className={LABEL_CLASS}>
            {labels.listingType}
          </label>
          <select
            id="listing-type"
            name="listingTypeCode"
            required
            value={values.listingTypeCode}
            onChange={(event) => set('listingTypeCode', event.target.value)}
            className={FIELD_CLASS}
          >
            <option value="product">{labels.typeProduct}</option>
            <option value="service">{labels.typeService}</option>
          </select>
        </div>

        <div>
          <label htmlFor="listing-category" className={LABEL_CLASS}>
            {labels.category}
          </label>
          <select
            id="listing-category"
            name="categorySlug"
            required
            value={values.categorySlug}
            onChange={(event) => set('categorySlug', event.target.value)}
            className={FIELD_CLASS}
          >
            <option value="" />
            {categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.categoryHint}</p>
        </div>

        <div>
          <label htmlFor="listing-language" className={LABEL_CLASS}>
            {labels.language}
          </label>
          <select
            id="listing-language"
            name="contentLanguage"
            required
            value={values.contentLanguage}
            onChange={(event) => set('contentLanguage', event.target.value)}
            className={FIELD_CLASS}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="listing-currency" className={LABEL_CLASS}>
            {labels.currency}
          </label>
          {currencies.length > 0 ? (
            <select
              id="listing-currency"
              name="currencyCode"
              required
              value={values.currencyCode}
              onChange={(event) => set('currencyCode', event.target.value)}
              className={FIELD_CLASS}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="listing-currency"
              name="currencyCode"
              type="text"
              required
              maxLength={3}
              value={values.currencyCode}
              onChange={(event) => set('currencyCode', event.target.value.toUpperCase())}
              className={FIELD_CLASS}
            />
          )}
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.currencyHint}</p>
        </div>

        <div>
          <label htmlFor="listing-country" className={LABEL_CLASS}>
            {labels.country}
          </label>
          <select
            id="listing-country"
            name="countryCode"
            required
            value={values.countryCode}
            onChange={(event) => set('countryCode', event.target.value)}
            className={FIELD_CLASS}
          >
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="listing-price" className={LABEL_CLASS}>
            {labels.price}
          </label>
          <input
            id="listing-price"
            name="priceMinor"
            type="text"
            inputMode="numeric"
            value={values.priceMinor}
            onChange={(event) => set('priceMinor', event.target.value)}
            className={FIELD_CLASS}
          />
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.priceHint}</p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="listing-negotiable"
            name="isNegotiable"
            type="checkbox"
            checked={values.isNegotiable !== ''}
            onChange={(event) => set('isNegotiable', event.target.checked ? 'yes' : '')}
            className="h-4 w-4 rounded border-edge"
          />
          <label htmlFor="listing-negotiable" className="text-sm text-ink-strong">
            {labels.negotiable}
          </label>
        </div>

        <div>
          <label htmlFor="listing-governorate" className={LABEL_CLASS}>
            {labels.governorate}
          </label>
          <input
            id="listing-governorate"
            name="governorate"
            type="text"
            value={values.governorate}
            onChange={(event) => set('governorate', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="listing-city" className={LABEL_CLASS}>
            {labels.city}
          </label>
          <input
            id="listing-city"
            name="city"
            type="text"
            value={values.city}
            onChange={(event) => set('city', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        {message !== null ? (
          <p role="alert" className="text-sm text-red-700">
            {message}
          </p>
        ) : null}
        {created ? (
          <p role="status" className="text-sm text-ink-strong">
            {labels.created}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60"
        >
          {pending ? labels.creating : labels.createSubmit}
        </button>
      </form>
    </section>
  );
}
