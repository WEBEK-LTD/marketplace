'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { accountRequest } from './account-request';

/**
 * The profile and settings forms (Phase 7-E).
 *
 * **What a person may edit about themselves, and nothing else.** The profile form holds four fields:
 * display name, full name, language and time zone. There is no phone input here — a number is changed
 * through the verified contact-change flow on the security page, which is the only path that exists —
 * and no status, role or permission field, because none of those is writable from any browser path at
 * all. The payload is built field by field from the state below, so there is no shape in which one of
 * them could be added.
 *
 * **Settings are a whole state.** Every switch is sent on every save, because a partial write would need
 * a merge rule and a merge rule is a second place the current state has to be known. Saving the same
 * values again is a success that changes nothing anybody can observe.
 *
 * **The server is authoritative.** An unknown language or time zone comes back as a refusal naming the
 * field, and the form says so rather than guessing.
 *
 * **A failure never clears the form.** The values live in one state object that no failure path touches.
 */

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';
const SUBMIT_CLASS =
  'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';

/* ------------------------------------------------------------------------------------------------ */
/* Profile                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface ProfileFormLabels {
  readonly displayName: string;
  readonly displayNameHint: string;
  readonly fullName: string;
  readonly fullNameHint: string;
  readonly language: string;
  readonly languageDefault: string;
  readonly timezone: string;
  readonly timezoneHint: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly invalidLanguage: string;
  readonly invalidTimezone: string;
  readonly invalid: string;
  readonly missing: string;
  readonly signedOut: string;
  readonly failed: string;
}

export interface ProfileFormValues {
  readonly displayName: string;
  readonly fullName: string;
  readonly localeCode: string;
  readonly timezone: string;
}

/** The two interface locales. `public.locales` remains the authority and refuses anything else. */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

export function BuyerProfileForm({
  labels,
  initial,
}: {
  readonly labels: ProfileFormLabels;
  readonly initial: ProfileFormValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProfileFormValues>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function set<K extends keyof ProfileFormValues>(field: K, value: ProfileFormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(false);
    setPending(true);

    try {
      const outcome = await accountRequest('/api/account/profile', {
        method: 'PATCH',
        body: {
          displayName: values.displayName.trim() === '' ? null : values.displayName.trim(),
          fullName: values.fullName.trim() === '' ? null : values.fullName.trim(),
          localeCode: values.localeCode === '' ? null : values.localeCode,
          timezone: values.timezone.trim(),
        },
      });

      if (outcome.status === 'ok') {
        setSaved(true);
        router.refresh();
        return;
      }
      if (outcome.status === 'invalid') {
        if (outcome.field === 'localeCode') setMessage(labels.invalidLanguage);
        else if (outcome.field === 'timezone') setMessage(labels.invalidTimezone);
        else setMessage(labels.invalid);
      } else if (outcome.status === 'missing') setMessage(labels.missing);
      else if (outcome.status === 'signed-out') setMessage(labels.signedOut);
      else setMessage(labels.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 max-w-lg space-y-4" noValidate>
      <div>
        <label className={LABEL_CLASS} htmlFor="profile-display-name">
          {labels.displayName}
        </label>
        <input
          id="profile-display-name"
          name="displayName"
          value={values.displayName}
          maxLength={80}
          onChange={(event) => set('displayName', event.target.value)}
          className={FIELD_CLASS}
          aria-describedby="profile-display-name-hint"
        />
        <p id="profile-display-name-hint" className="mt-1 text-xs text-ink-muted">
          {labels.displayNameHint}
        </p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="profile-full-name">
          {labels.fullName}
        </label>
        <input
          id="profile-full-name"
          name="fullName"
          value={values.fullName}
          maxLength={160}
          onChange={(event) => set('fullName', event.target.value)}
          className={FIELD_CLASS}
          aria-describedby="profile-full-name-hint"
        />
        <p id="profile-full-name-hint" className="mt-1 text-xs text-ink-muted">
          {labels.fullNameHint}
        </p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="profile-language">
          {labels.language}
        </label>
        <select
          id="profile-language"
          name="localeCode"
          value={values.localeCode}
          onChange={(event) => set('localeCode', event.target.value)}
          className={FIELD_CLASS}
        >
          <option value="">{labels.languageDefault}</option>
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="profile-timezone">
          {labels.timezone}
        </label>
        <input
          id="profile-timezone"
          name="timezone"
          value={values.timezone}
          maxLength={64}
          onChange={(event) => set('timezone', event.target.value)}
          className={FIELD_CLASS}
          aria-describedby="profile-timezone-hint"
        />
        <p id="profile-timezone-hint" className="mt-1 text-xs text-ink-muted">
          {labels.timezoneHint}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT_CLASS}>
          {pending ? labels.saving : labels.save}
        </button>
        {saved && (
          <span role="status" className="text-sm text-ink-body">
            {labels.saved}
          </span>
        )}
        {message !== null && (
          <span role="alert" className="text-sm text-ink-strong">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Settings                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface SettingsFormLabels {
  readonly channelsHeading: string;
  readonly channelsIntro: string;
  readonly notifyInApp: string;
  readonly notifyEmail: string;
  readonly notifySms: string;
  readonly notifyWhatsapp: string;
  readonly marketingOptIn: string;
  readonly marketingHint: string;
  readonly displayHeading: string;
  readonly digitStyle: string;
  readonly digitStyleDefault: string;
  readonly digitStyleWestern: string;
  readonly digitStyleArabicIndic: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly invalid: string;
  readonly missing: string;
  readonly signedOut: string;
  readonly failed: string;
}

export interface SettingsFormValues {
  readonly notifyEmail: boolean;
  readonly notifySms: boolean;
  readonly notifyWhatsapp: boolean;
  readonly notifyInApp: boolean;
  readonly marketingOptIn: boolean;
  readonly digitStyle: '' | 'western' | 'arabic_indic';
}

export function BuyerSettingsForm({
  labels,
  initial,
}: {
  readonly labels: SettingsFormLabels;
  readonly initial: SettingsFormValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SettingsFormValues>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function set<K extends keyof SettingsFormValues>(field: K, value: SettingsFormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(false);
    setPending(true);

    try {
      const outcome = await accountRequest('/api/account/settings', {
        method: 'PUT',
        body: {
          notifyEmail: values.notifyEmail,
          notifySms: values.notifySms,
          notifyWhatsapp: values.notifyWhatsapp,
          notifyInApp: values.notifyInApp,
          marketingOptIn: values.marketingOptIn,
          digitStyle: values.digitStyle === '' ? null : values.digitStyle,
        },
      });

      if (outcome.status === 'ok') {
        setSaved(true);
        router.refresh();
        return;
      }
      if (outcome.status === 'invalid') setMessage(labels.invalid);
      else if (outcome.status === 'missing') setMessage(labels.missing);
      else if (outcome.status === 'signed-out') setMessage(labels.signedOut);
      else setMessage(labels.failed);
    } finally {
      setPending(false);
    }
  }

  const toggle = (field: keyof SettingsFormValues, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm text-ink-strong">
      <input
        type="checkbox"
        name={String(field)}
        checked={values[field] === true}
        onChange={(event) => set(field, event.target.checked as SettingsFormValues[typeof field])}
        className="mt-1"
      />
      <span>
        {label}
        {hint !== undefined && <span className="mt-1 block text-xs font-normal text-ink-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 max-w-lg space-y-6" noValidate>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink-strong">{labels.channelsHeading}</legend>
        <p className="text-xs text-ink-muted">{labels.channelsIntro}</p>
        {toggle('notifyInApp', labels.notifyInApp)}
        {toggle('notifyEmail', labels.notifyEmail)}
        {toggle('notifySms', labels.notifySms)}
        {toggle('notifyWhatsapp', labels.notifyWhatsapp)}
        {toggle('marketingOptIn', labels.marketingOptIn, labels.marketingHint)}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink-strong">{labels.displayHeading}</legend>
        <div>
          <label className={LABEL_CLASS} htmlFor="settings-digit-style">
            {labels.digitStyle}
          </label>
          <select
            id="settings-digit-style"
            name="digitStyle"
            value={values.digitStyle}
            onChange={(event) => set('digitStyle', event.target.value as SettingsFormValues['digitStyle'])}
            className={FIELD_CLASS}
          >
            <option value="">{labels.digitStyleDefault}</option>
            <option value="western">{labels.digitStyleWestern}</option>
            <option value="arabic_indic">{labels.digitStyleArabicIndic}</option>
          </select>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT_CLASS}>
          {pending ? labels.saving : labels.save}
        </button>
        {saved && (
          <span role="status" className="text-sm text-ink-body">
            {labels.saved}
          </span>
        )}
        {message !== null && (
          <span role="alert" className="text-sm text-ink-strong">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}
