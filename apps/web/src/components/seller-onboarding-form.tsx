'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  EMPTY_ONBOARDING_VALUES,
  buildOnboardingRequest,
  submitOnboarding,
  type OnboardingField,
  type OnboardingValues,
  type RenderableCreatedSeller,
} from './seller-onboarding';

/**
 * The seller onboarding form (Phase 6-C).
 *
 * **What crosses the server/client boundary.** Strings, and nothing else. Every label arrives as a plain
 * string prop, so the RSC payload of this page carries the form's copy and no data: no user id, no access
 * token, no legal name, no API address, no seller object. There is nothing to narrow because nothing but
 * copy is passed — the storefront this form renders on success comes from the server's *response*, in the
 * browser, projected through a narrowed render type on the way in.
 *
 * **The server is authoritative.** The checks here are the shared contract's own, applied for the person's
 * benefit so a mistyped address is caught before a round trip; every one of them is applied again upstream,
 * and a value this form accepted can still be refused. Nothing here decides anything.
 *
 * **A failure never clears the form.** The values live in one state object that a refusal does not touch, so
 * somebody who mistyped a slug loses the slug and not the bio, the legal name and the phone number they had
 * just finished typing. This is why the fields are controlled inputs rather than an uncontrolled `<form>`
 * read on submit.
 *
 * **The slug is permanent, and the form says so where the slug is typed** rather than in a paragraph
 * somebody has already scrolled past. It is the one field whose value can never be corrected.
 *
 * On success the created storefront is shown from the server's response — never an invented id or timestamp,
 * because the response carries neither — and the route is refreshed so the page becomes the ordinary 6-B
 * dashboard state, read back from the database rather than assumed.
 */

export interface SellerOnboardingLabels {
  readonly createProfile: string;
  readonly slug: string;
  readonly slugHint: string;
  readonly slugPermanent: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly bio: string;
  readonly language: string;
  readonly country: string;
  readonly governorate: string;
  readonly city: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly submit: string;
  readonly submitting: string;
  readonly pending: string;
  readonly errorExists: string;
  readonly errorSlugTaken: string;
  readonly errorInvalid: string;
  readonly errorUnavailable: string;
  readonly retry: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-900';

/**
 * The languages a seller may write their storefront in: this interface's own two locales.
 *
 * A fixed pair rather than a lookup, because there is no locales endpoint in V1 and inventing one here would
 * be inventing an API. The database's foreign key onto `public.locales` remains the authority, and a code it
 * does not know is refused there.
 */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

/**
 * The countries a storefront may sit in.
 *
 * One, because Egypt is the only marketplace-enabled country in V1 (D17, seeded in 0033), and the code is
 * rendered as the code — which is what the 6-B account view already shows a seller. A countries endpoint and
 * a localised country name are a later increment's business; a select with one value cannot produce something
 * the database would refuse.
 */
const COUNTRIES: readonly string[] = ['EG'];

export function SellerOnboardingForm({ labels }: { readonly labels: SellerOnboardingLabels }) {
  const router = useRouter();
  const [values, setValues] = useState<OnboardingValues>({
    ...EMPTY_ONBOARDING_VALUES,
    countryCode: COUNTRIES[0] ?? '',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<RenderableCreatedSeller | null>(null);

  function set(field: OnboardingField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);

    const built = buildOnboardingRequest(values);
    if (!built.ok) {
      setMessage(labels.errorInvalid);
      return;
    }

    setPending(true);
    try {
      const outcome = await submitOnboarding(built.body);
      if (outcome.kind === 'created') {
        setCreated(outcome.seller);
        // The page re-reads the caller's identity on the server, so what replaces this form is the real
        // dashboard state rather than anything this component decided.
        router.refresh();
        return;
      }
      if (outcome.kind === 'exists') setMessage(labels.errorExists);
      else if (outcome.kind === 'slug_taken') setMessage(labels.errorSlugTaken);
      else if (outcome.kind === 'invalid') setMessage(labels.errorInvalid);
      else setMessage(labels.errorUnavailable);
    } finally {
      setPending(false);
    }
  }

  if (created !== null) {
    return (
      <section aria-labelledby="seller-created" className="mt-8">
        <h2 id="seller-created" className="text-lg font-semibold text-neutral-900">
          {created.displayName}
        </h2>
        <p role="status" className="mt-2 max-w-prose text-neutral-700">
          {labels.pending}
        </p>
        <dl className="mt-4 max-w-md">
          <div className="flex justify-between gap-4 border-b border-neutral-100 py-2">
            <dt className="text-sm text-neutral-600">{labels.slugHint}</dt>
            <dd className="text-sm text-neutral-900">{created.slug}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-neutral-100 py-2">
            <dt className="text-sm text-neutral-600">{labels.country}</dt>
            <dd className="text-sm text-neutral-900">{created.countryCode}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section aria-labelledby="seller-onboarding" className="mt-8 max-w-xl">
      <h2 id="seller-onboarding" className="text-lg font-semibold text-neutral-900">
        {labels.createProfile}
      </h2>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <div>
          <label htmlFor="seller-slug" className={LABEL_CLASS}>
            {labels.slug}
          </label>
          <input
            id="seller-slug"
            name="slug"
            type="text"
            required
            autoComplete="off"
            value={values.slug}
            onChange={(event) => set('slug', event.target.value)}
            aria-describedby="seller-slug-hint seller-slug-permanent"
            className={FIELD_CLASS}
          />
          <p id="seller-slug-hint" className="mt-1 text-sm text-neutral-600">
            {labels.slugHint}
          </p>
          {/* The one warning this form makes, next to the one field that cannot be corrected later. */}
          <p id="seller-slug-permanent" className="mt-1 text-sm font-medium text-neutral-900">
            {labels.slugPermanent}
          </p>
        </div>

        <div>
          <label htmlFor="seller-display-name" className={LABEL_CLASS}>
            {labels.displayName}
          </label>
          <input
            id="seller-display-name"
            name="displayName"
            type="text"
            required
            value={values.displayName}
            onChange={(event) => set('displayName', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-legal-name" className={LABEL_CLASS}>
            {labels.legalName}
          </label>
          <input
            id="seller-legal-name"
            name="legalName"
            type="text"
            value={values.legalName}
            onChange={(event) => set('legalName', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-bio" className={LABEL_CLASS}>
            {labels.bio}
          </label>
          <textarea
            id="seller-bio"
            name="bio"
            rows={4}
            maxLength={2000}
            value={values.bio}
            onChange={(event) => set('bio', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-language" className={LABEL_CLASS}>
            {labels.language}
          </label>
          <select
            id="seller-language"
            name="contentLanguage"
            value={values.contentLanguage}
            onChange={(event) => set('contentLanguage', event.target.value)}
            className={FIELD_CLASS}
          >
            <option value="" />
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="seller-country" className={LABEL_CLASS}>
            {labels.country}
          </label>
          <select
            id="seller-country"
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
          <label htmlFor="seller-governorate" className={LABEL_CLASS}>
            {labels.governorate}
          </label>
          <input
            id="seller-governorate"
            name="governorate"
            type="text"
            value={values.governorate}
            onChange={(event) => set('governorate', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-city" className={LABEL_CLASS}>
            {labels.city}
          </label>
          <input
            id="seller-city"
            name="city"
            type="text"
            value={values.city}
            onChange={(event) => set('city', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-contact-email" className={LABEL_CLASS}>
            {labels.contactEmail}
          </label>
          <input
            id="seller-contact-email"
            name="contactEmail"
            type="email"
            autoComplete="email"
            value={values.contactEmail}
            onChange={(event) => set('contactEmail', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="seller-contact-phone" className={LABEL_CLASS}>
            {labels.contactPhone}
          </label>
          <input
            id="seller-contact-phone"
            name="contactPhone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={values.contactPhone}
            onChange={(event) => set('contactPhone', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        {message === null ? null : (
          <p role="alert" className="text-sm text-red-700">
            {message} — {labels.retry}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          {pending ? labels.submitting : labels.submit}
        </button>
      </form>
    </section>
  );
}
