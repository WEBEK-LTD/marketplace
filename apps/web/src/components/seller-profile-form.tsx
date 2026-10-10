'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  buildProfileUpdate,
  initialProfileValues,
  submitProfileUpdate,
  type KnownProfileValues,
  type ProfileField,
  type ProfileValues,
} from './seller-profile-edit';

/**
 * The seller profile form (Phase 6-D).
 *
 * **What crosses the server/client boundary.** Copy, and three values: the display name, the city and the
 * country code — the editable fields the 6-A projection carries, which the form must show in order to let
 * somebody edit them. They arrive as a narrowed {@link KnownProfileValues}, projected field by field on the
 * server, never as the identity object and never as an API envelope. No user id, no token, no legal name, no
 * suspension reason, no object path, no timestamp: none of those is in the projection, so none of them can
 * be in the payload.
 *
 * The slug, the status and the verification state are **not** props of this component at all. They are
 * read-only facts, rendered by the server page around this form, so there is no version of them in the
 * client bundle that could be edited, posted or confused with an input.
 *
 * **The server is authoritative.** The checks here are the shared contract's own, applied so a mistyped
 * address is caught before a round trip; every one is applied again upstream, and a value this form accepted
 * can still be refused.
 *
 * **A failure never clears the form.** The values live in one state object that no failure path touches, so
 * somebody who mistyped a phone number loses the phone number and not the bio they had just written.
 *
 * **No optimistic update.** On success the displayed identity is replaced by what the *server* returned —
 * never by what was typed — and the route is refreshed so the surrounding page re-reads the storefront from
 * the database. A saved state that showed the typed values would show a change that might not have happened.
 */

export interface SellerProfileFormLabels {
  readonly edit: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly bio: string;
  readonly language: string;
  readonly country: string;
  readonly governorate: string;
  readonly city: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly errorInvalid: string;
  readonly errorUnavailable: string;
  readonly notEditable: string;
  readonly retry: string;
  readonly unchangedHint: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';

/** The two interface locales, as 6-C renders them. `public.locales` remains the authority. */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

/** Egypt is the only marketplace-enabled country in V1 (D17), and the code is what 6-B already shows. */
const COUNTRIES: readonly string[] = ['EG'];

export function SellerProfileForm({
  labels,
  known,
}: {
  readonly labels: SellerProfileFormLabels;
  readonly known: KnownProfileValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProfileValues>(() => initialProfileValues(known));
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function set(field: ProfileField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(false);

    const built = buildProfileUpdate(values, known);
    if (!built.ok) {
      setMessage(labels.errorInvalid);
      return;
    }
    // Nothing was altered. There is no request to make and nothing to report.
    if (!built.changed) {
      setSaved(true);
      return;
    }

    setPending(true);
    try {
      const outcome = await submitProfileUpdate(built.body);
      if (outcome.kind === 'saved') {
        setSaved(true);
        // The page re-reads the storefront on the server, so what is displayed afterwards is what is
        // stored rather than anything this component decided.
        router.refresh();
        return;
      }
      if (outcome.kind === 'invalid') setMessage(labels.errorInvalid);
      else if (outcome.kind === 'not_editable') setMessage(labels.notEditable);
      else setMessage(labels.errorUnavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="seller-profile-edit" className="mt-8 max-w-xl">
      <h2 id="seller-profile-edit" className="text-lg font-semibold text-ink-strong">
        {labels.edit}
      </h2>

      {/* Six of the nine editable fields are not in the seller identity this page can read, so their boxes
          start blank and a blank box keeps what is stored. Said once, here, rather than on six fields. */}
      <p className="mt-2 max-w-prose text-sm text-ink-muted">{labels.unchangedHint}</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <div>
          <label htmlFor="profile-display-name" className={LABEL_CLASS}>
            {labels.displayName}
          </label>
          <input
            id="profile-display-name"
            name="displayName"
            type="text"
            required
            value={values.displayName}
            onChange={(event) => set('displayName', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-legal-name" className={LABEL_CLASS}>
            {labels.legalName}
          </label>
          <input
            id="profile-legal-name"
            name="legalName"
            type="text"
            value={values.legalName}
            onChange={(event) => set('legalName', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-bio" className={LABEL_CLASS}>
            {labels.bio}
          </label>
          <textarea
            id="profile-bio"
            name="bio"
            rows={4}
            maxLength={2000}
            value={values.bio}
            onChange={(event) => set('bio', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-language" className={LABEL_CLASS}>
            {labels.language}
          </label>
          <select
            id="profile-language"
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
          <label htmlFor="profile-country" className={LABEL_CLASS}>
            {labels.country}
          </label>
          <select
            id="profile-country"
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
          <label htmlFor="profile-governorate" className={LABEL_CLASS}>
            {labels.governorate}
          </label>
          <input
            id="profile-governorate"
            name="governorate"
            type="text"
            value={values.governorate}
            onChange={(event) => set('governorate', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-city" className={LABEL_CLASS}>
            {labels.city}
          </label>
          <input
            id="profile-city"
            name="city"
            type="text"
            value={values.city}
            onChange={(event) => set('city', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-contact-email" className={LABEL_CLASS}>
            {labels.contactEmail}
          </label>
          <input
            id="profile-contact-email"
            name="contactEmail"
            type="email"
            autoComplete="email"
            value={values.contactEmail}
            onChange={(event) => set('contactEmail', event.target.value)}
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <label htmlFor="profile-contact-phone" className={LABEL_CLASS}>
            {labels.contactPhone}
          </label>
          <input
            id="profile-contact-phone"
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
        {saved && message === null ? (
          <p role="status" className="text-sm text-ink-strong">
            {labels.saved}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
        >
          {pending ? labels.saving : labels.save}
        </button>
      </form>
    </section>
  );
}
