'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { accountRequest } from './account-request';

/**
 * Adding and editing an address (Phase 7-E).
 *
 * **Every rule here is the schema's, restated where a form can act on it.** The three purposes, the
 * E.164 phone shape, the four required parts and the two-letter country code all come from migration
 * 0005; none of them is invented here, and each is applied again upstream. A value this form accepted
 * can still be refused — a shipping address in a country the marketplace does not ship to comes back as
 * its own answer, which is why that refusal has a sentence of its own rather than a generic failure.
 *
 * **Nothing here touches shipping or an order.** An address on this surface is a record the person keeps
 * about themselves. There is no delivery option, no rate, no method: shipping is Phase 8.
 *
 * **The country list is the server's.** It arrives as a narrow list of codes, names and the one flag
 * D17's trigger tests, so a person choosing a country for shipping can be told before they submit —
 * without this component knowing anything about how the rule is enforced.
 *
 * **A failure never clears the form.** The values live in one state object that no failure path touches.
 */

export interface AddressFormLabels {
  readonly label: string;
  readonly labelHint: string;
  readonly purpose: string;
  readonly purposeShipping: string;
  readonly purposeBilling: string;
  readonly purposeBoth: string;
  readonly recipientName: string;
  readonly phone: string;
  readonly phoneHint: string;
  readonly country: string;
  readonly countryNotShippable: string;
  readonly governorate: string;
  readonly city: string;
  readonly district: string;
  readonly streetAddress: string;
  readonly building: string;
  readonly apartment: string;
  readonly postalCode: string;
  readonly landmark: string;
  readonly defaultShipping: string;
  readonly defaultBilling: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly cancel: string;
  readonly required: string;
  readonly invalidPhone: string;
  readonly invalid: string;
  readonly missing: string;
  readonly signedOut: string;
  readonly failed: string;
  readonly notShippable: string;
}

export interface CountryOption {
  readonly code: string;
  readonly name: string;
  readonly isMarketplaceEnabled: boolean;
}

export interface AddressValues {
  readonly id: string | null;
  readonly label: string;
  readonly purpose: 'shipping' | 'billing' | 'both';
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly countryCode: string;
  readonly governorate: string;
  readonly city: string;
  readonly district: string;
  readonly streetAddress: string;
  readonly building: string;
  readonly apartment: string;
  readonly postalCode: string;
  readonly landmark: string;
  readonly isDefaultShipping: boolean;
  readonly isDefaultBilling: boolean;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-900';

/** 0005's own `addresses_phone_format`, so a mistyped number is caught before a round trip. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function emptyAddress(countryCode: string): AddressValues {
  return {
    id: null,
    label: '',
    purpose: 'both',
    recipientName: '',
    phoneE164: '',
    countryCode,
    governorate: '',
    city: '',
    district: '',
    streetAddress: '',
    building: '',
    apartment: '',
    postalCode: '',
    landmark: '',
    isDefaultShipping: false,
    isDefaultBilling: false,
  };
}

export function AddressForm({
  labels,
  countries,
  initial,
  onDone,
}: {
  readonly labels: AddressFormLabels;
  readonly countries: readonly CountryOption[];
  readonly initial: AddressValues;
  readonly onDone?: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<AddressValues>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function set<K extends keyof AddressValues>(field: K, value: AddressValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  const chosen = countries.find((country) => country.code === values.countryCode);
  const shippingHere = values.purpose !== 'billing';
  const warnNotShippable = chosen !== undefined && shippingHere && !chosen.isMarketplaceEnabled;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(false);

    for (const field of ['recipientName', 'governorate', 'city', 'streetAddress'] as const) {
      if (values[field].trim() === '') {
        setMessage(labels.required);
        return;
      }
    }
    if (!E164.test(values.phoneE164.trim())) {
      setMessage(labels.invalidPhone);
      return;
    }

    const body = {
      label: values.label.trim() === '' ? null : values.label.trim(),
      purpose: values.purpose,
      recipientName: values.recipientName.trim(),
      phoneE164: values.phoneE164.trim(),
      countryCode: values.countryCode,
      governorate: values.governorate.trim(),
      city: values.city.trim(),
      district: values.district.trim() === '' ? null : values.district.trim(),
      streetAddress: values.streetAddress.trim(),
      building: values.building.trim() === '' ? null : values.building.trim(),
      apartment: values.apartment.trim() === '' ? null : values.apartment.trim(),
      postalCode: values.postalCode.trim() === '' ? null : values.postalCode.trim(),
      landmark: values.landmark.trim() === '' ? null : values.landmark.trim(),
      // The schema refuses a default that contradicts its purpose, so neither is sent when it would.
      isDefaultShipping: values.purpose !== 'billing' && values.isDefaultShipping,
      isDefaultBilling: values.purpose !== 'shipping' && values.isDefaultBilling,
    };

    setPending(true);
    try {
      const outcome = await accountRequest(
        values.id === null ? '/api/account/addresses' : `/api/account/addresses/${values.id}`,
        { method: values.id === null ? 'POST' : 'PATCH', body },
      );

      if (outcome.status === 'ok') {
        setSaved(true);
        onDone?.();
        router.refresh();
        return;
      }
      if (outcome.status === 'conflict') setMessage(labels.notShippable);
      else if (outcome.status === 'invalid') setMessage(labels.invalid);
      else if (outcome.status === 'missing') setMessage(labels.missing);
      else if (outcome.status === 'signed-out') setMessage(labels.signedOut);
      else setMessage(labels.failed);
    } finally {
      setPending(false);
    }
  }

  const text = (
    field: keyof AddressValues,
    label: string,
    options: { required?: boolean; hint?: string; maxLength?: number } = {},
  ) => (
    <div>
      <label className={LABEL_CLASS} htmlFor={`address-${String(field)}`}>
        {label}
      </label>
      <input
        id={`address-${String(field)}`}
        name={String(field)}
        value={values[field] as string}
        required={options.required === true}
        maxLength={options.maxLength ?? 160}
        onChange={(event) => set(field, event.target.value as AddressValues[typeof field])}
        className={FIELD_CLASS}
        {...(options.hint === undefined ? {} : { 'aria-describedby': `address-${String(field)}-hint` })}
      />
      {options.hint !== undefined && (
        <p id={`address-${String(field)}-hint`} className="mt-1 text-xs text-neutral-600">
          {options.hint}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 max-w-2xl space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('label', labels.label, { hint: labels.labelHint, maxLength: 80 })}
        <div>
          <label className={LABEL_CLASS} htmlFor="address-purpose">
            {labels.purpose}
          </label>
          <select
            id="address-purpose"
            name="purpose"
            value={values.purpose}
            onChange={(event) => set('purpose', event.target.value as AddressValues['purpose'])}
            className={FIELD_CLASS}
          >
            <option value="both">{labels.purposeBoth}</option>
            <option value="shipping">{labels.purposeShipping}</option>
            <option value="billing">{labels.purposeBilling}</option>
          </select>
        </div>
        {text('recipientName', labels.recipientName, { required: true })}
        {text('phoneE164', labels.phone, { required: true, hint: labels.phoneHint, maxLength: 16 })}
        <div>
          <label className={LABEL_CLASS} htmlFor="address-countryCode">
            {labels.country}
          </label>
          <select
            id="address-countryCode"
            name="countryCode"
            value={values.countryCode}
            onChange={(event) => set('countryCode', event.target.value)}
            className={FIELD_CLASS}
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
                {country.isMarketplaceEnabled ? '' : ` — ${labels.countryNotShippable}`}
              </option>
            ))}
          </select>
          {warnNotShippable && (
            <p role="status" className="mt-1 text-xs text-neutral-900">
              {labels.notShippable}
            </p>
          )}
        </div>
        {text('governorate', labels.governorate, { required: true, maxLength: 120 })}
        {text('city', labels.city, { required: true, maxLength: 120 })}
        {text('district', labels.district, { maxLength: 120 })}
        {text('streetAddress', labels.streetAddress, { required: true, maxLength: 240 })}
        {text('building', labels.building, { maxLength: 60 })}
        {text('apartment', labels.apartment, { maxLength: 60 })}
        {text('postalCode', labels.postalCode, { maxLength: 20 })}
        {text('landmark', labels.landmark, { maxLength: 160 })}
      </div>

      <div className="space-y-2">
        {values.purpose !== 'billing' && (
          <label className="flex items-center gap-2 text-sm text-neutral-900">
            <input
              type="checkbox"
              name="isDefaultShipping"
              checked={values.isDefaultShipping}
              onChange={(event) => set('isDefaultShipping', event.target.checked)}
            />
            {labels.defaultShipping}
          </label>
        )}
        {values.purpose !== 'shipping' && (
          <label className="flex items-center gap-2 text-sm text-neutral-900">
            <input
              type="checkbox"
              name="isDefaultBilling"
              checked={values.isDefaultBilling}
              onChange={(event) => set('isDefaultBilling', event.target.checked)}
            />
            {labels.defaultBilling}
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? labels.saving : labels.save}
        </button>
        {onDone !== undefined && (
          <button type="button" onClick={onDone} className="text-sm underline underline-offset-4">
            {labels.cancel}
          </button>
        )}
        {saved && (
          <span role="status" className="text-sm text-neutral-700">
            {labels.saved}
          </span>
        )}
        {message !== null && (
          <span role="alert" className="text-sm text-neutral-900">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

/** The add form, revealed by a button so the list is what a person sees first. */
export function NewAddress({
  labels,
  countries,
  addLabel,
  defaultCountry,
}: {
  readonly labels: AddressFormLabels;
  readonly countries: readonly CountryOption[];
  readonly addLabel: string;
  readonly defaultCountry: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
      >
        {addLabel}
      </button>
    );
  }
  return (
    <AddressForm
      labels={labels}
      countries={countries}
      initial={emptyAddress(defaultCountry)}
      onDone={() => setOpen(false)}
    />
  );
}

/** The edit form for one existing address, revealed in place. */
export function EditAddress({
  labels,
  countries,
  editLabel,
  initial,
}: {
  readonly labels: AddressFormLabels;
  readonly countries: readonly CountryOption[];
  readonly editLabel: string;
  readonly initial: AddressValues;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-900"
      >
        {editLabel}
      </button>
    );
  }
  return <AddressForm labels={labels} countries={countries} initial={initial} onDone={() => setOpen(false)} />;
}
