'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  EMPTY_SERVICE_CREATE_VALUES,
  buildServiceCreate,
  submitServiceCreate,
  type ServiceCreateField,
  type ServiceCreateValues,
} from './seller-service-forms';

/**
 * The create-a-service-draft form (Phase 6-G).
 *
 * **What crosses the server/client boundary.** Copy, a list of `{ slug, name }` category pairs and a list of
 * currency codes. The category tree the server reads also carries a uuid per node; it is projected away on
 * the server, so no identifier of any kind appears in this component's props and therefore none appears in
 * the RSC payload. No seller, no account, no token, no status.
 *
 * **The pricing block is optional, and says so.** Leave the model unstated and nothing about pricing is
 * recorded, which is a real state in the schema rather than a gap. State it and the four fields that hang
 * off it become meaningful; state one of them without it and the form refuses, because a revision count that
 * belongs to no pricing model is not a fact about a service.
 *
 * **The server is authoritative.** Every check here is the shared contract's or the detail table's own,
 * applied so a mistake costs no round trip. Each is applied again in the API and again in the database,
 * either of which may still refuse a value this accepted — a category that does not take services, for
 * instance, which the public tree gives this form no way to know.
 *
 * **A failure never clears the form**, and **no write is optimistic**: on success the route is refreshed so
 * the surrounding page re-reads the services from the database.
 */

export interface SellerServiceCreateLabels {
  readonly create: string;
  readonly slug: string;
  readonly slugPermanent: string;
  readonly titleField: string;
  readonly description: string;
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
  readonly pricing: string;
  readonly pricingModel: string;
  readonly pricingUnset: string;
  readonly pricingFixed: string;
  readonly pricingCustom: string;
  readonly pricingHint: string;
  readonly deliveryDays: string;
  readonly deliveryDaysHint: string;
  readonly revisions: string;
  readonly requiresBrief: string;
  readonly scope: string;
  readonly createSubmit: string;
  readonly creating: string;
  readonly created: string;
  readonly errorInvalid: string;
  readonly errorSlugTaken: string;
  readonly errorNotEditable: string;
  readonly errorUnavailable: string;
}

/** A category as this form may see it: a public address and a name. No identifier. */
export interface RenderableServiceCategory {
  readonly slug: string;
  readonly name: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';

/** The two interface locales, as every seller form renders them. `public.locales` remains the authority. */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

/** Egypt is the only marketplace-enabled country in V1 (D17). No currency is named here — see E3. */
const COUNTRIES: readonly string[] = ['EG'];

export function SellerServiceCreateForm({
  labels,
  categories,
  currencies,
}: {
  readonly labels: SellerServiceCreateLabels;
  readonly categories: readonly RenderableServiceCategory[];
  /**
   * The currencies this seller already prices in, read off their own services. Empty for a seller with no
   * services yet, and then the form asks for a code rather than naming one — owner decision E3.
   */
  readonly currencies: readonly string[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<ServiceCreateValues>(() => ({
    ...EMPTY_SERVICE_CREATE_VALUES,
    currencyCode: currencies[0] ?? '',
  }));
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [pending, setPending] = useState(false);

  function set(field: ServiceCreateField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setCreated(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setCreated(false);

    const built = buildServiceCreate(values);
    if (!built.ok) {
      setMessage(labels.errorInvalid);
      return;
    }

    setPending(true);
    try {
      const outcome = await submitServiceCreate(built.body);
      if (outcome.kind === 'ok') {
        setCreated(true);
        setValues({ ...EMPTY_SERVICE_CREATE_VALUES, currencyCode: currencies[0] ?? '' });
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

  const pricingStated = values.pricingModel !== '';

  return (
    <section aria-labelledby="seller-service-create-heading" className="mt-10 max-w-xl">
      <h2 id="seller-service-create-heading" className="text-lg font-semibold text-ink-strong">
        {labels.create}
      </h2>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <div>
          <label htmlFor="service-slug" className={LABEL_CLASS}>
            {labels.slug}
          </label>
          <input
            id="service-slug"
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
          <label htmlFor="service-title" className={LABEL_CLASS}>
            {labels.titleField}
          </label>
          <input
            id="service-title"
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
          <label htmlFor="service-description" className={LABEL_CLASS}>
            {labels.description}
          </label>
          <textarea
            id="service-description"
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
          <label htmlFor="service-category" className={LABEL_CLASS}>
            {labels.category}
          </label>
          <select
            id="service-category"
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
          <label htmlFor="service-language" className={LABEL_CLASS}>
            {labels.language}
          </label>
          <select
            id="service-language"
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
          <label htmlFor="service-currency" className={LABEL_CLASS}>
            {labels.currency}
          </label>
          {currencies.length > 0 ? (
            <select
              id="service-currency"
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
              id="service-currency"
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
          <label htmlFor="service-country" className={LABEL_CLASS}>
            {labels.country}
          </label>
          <select
            id="service-country"
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
          <label htmlFor="service-price" className={LABEL_CLASS}>
            {labels.price}
          </label>
          <input
            id="service-price"
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
            id="service-negotiable"
            name="isNegotiable"
            type="checkbox"
            checked={values.isNegotiable !== ''}
            onChange={(event) => set('isNegotiable', event.target.checked ? 'yes' : '')}
            className="h-4 w-4 rounded border-edge"
          />
          <label htmlFor="service-negotiable" className="text-sm text-ink-strong">
            {labels.negotiable}
          </label>
        </div>

        <div>
          <label htmlFor="service-governorate" className={LABEL_CLASS}>
            {labels.governorate}
          </label>
          <input
            id="service-governorate"
            name="governorate"
            type="text"
            value={values.governorate}
            onChange={(event) => set('governorate', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="service-city" className={LABEL_CLASS}>
            {labels.city}
          </label>
          <input
            id="service-city"
            name="city"
            type="text"
            value={values.city}
            onChange={(event) => set('city', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        {/* The pricing block. Its four dependent fields appear only once a model is stated, because until
            then there is nothing for them to belong to and the database would refuse them. */}
        <fieldset className="border-t border-hairline pt-5">
          <legend className="text-sm font-semibold text-ink-strong">{labels.pricing}</legend>

          <div className="mt-3">
            <label htmlFor="service-pricing-model" className={LABEL_CLASS}>
              {labels.pricingModel}
            </label>
            <select
              id="service-pricing-model"
              name="pricingModel"
              value={values.pricingModel}
              onChange={(event) => set('pricingModel', event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">{labels.pricingUnset}</option>
              <option value="fixed">{labels.pricingFixed}</option>
              <option value="custom">{labels.pricingCustom}</option>
            </select>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.pricingHint}</p>
          </div>

          {pricingStated ? (
            <>
              <div className="mt-4">
                <label htmlFor="service-delivery-days" className={LABEL_CLASS}>
                  {labels.deliveryDays}
                </label>
                <input
                  id="service-delivery-days"
                  name="deliveryDays"
                  type="text"
                  inputMode="numeric"
                  required={values.pricingModel === 'fixed'}
                  value={values.deliveryDays}
                  onChange={(event) => set('deliveryDays', event.target.value)}
                  className={FIELD_CLASS}
                />
                <p className="mt-1 max-w-prose text-sm text-ink-muted">{labels.deliveryDaysHint}</p>
              </div>

              <div className="mt-4">
                <label htmlFor="service-revisions" className={LABEL_CLASS}>
                  {labels.revisions}
                </label>
                <input
                  id="service-revisions"
                  name="revisionsIncluded"
                  type="text"
                  inputMode="numeric"
                  value={values.revisionsIncluded}
                  onChange={(event) => set('revisionsIncluded', event.target.value)}
                  className={FIELD_CLASS}
                />
              </div>

              <div className="mt-4 flex items-center gap-2">
                <input
                  id="service-requires-brief"
                  name="requiresBrief"
                  type="checkbox"
                  checked={values.requiresBrief !== ''}
                  onChange={(event) => set('requiresBrief', event.target.checked ? 'yes' : '')}
                  className="h-4 w-4 rounded border-edge"
                />
                <label htmlFor="service-requires-brief" className="text-sm text-ink-strong">
                  {labels.requiresBrief}
                </label>
              </div>

              <div className="mt-4">
                <label htmlFor="service-scope" className={LABEL_CLASS}>
                  {labels.scope}
                </label>
                <textarea
                  id="service-scope"
                  name="scope"
                  rows={3}
                  maxLength={5000}
                  value={values.scope}
                  onChange={(event) => set('scope', event.target.value)}
                  className={FIELD_CLASS}
                />
              </div>
            </>
          ) : null}
        </fieldset>

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
