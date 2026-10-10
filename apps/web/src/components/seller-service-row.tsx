'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  archiveListing,
  buildServiceUpdate,
  initialServiceUpdateValues,
  serviceActions,
  serviceAmount,
  submitListingForReview,
  submitServiceUpdate,
  type RenderableService,
  type ServiceUpdateField,
  type ServiceUpdateValues,
} from './seller-service-forms';

/**
 * One service, and whatever S-8 lets its seller do with it (Phase 6-G).
 *
 * **What crosses the server/client boundary.** Copy, one {@link RenderableService} — a narrowed render type
 * projected field by field on the server — one boolean saying whether the storefront may mutate, and one
 * label group per action this service actually offers. A null group means that action is not offered, so a
 * control this state does not allow has no text to render with and its copy is not in the RSC payload
 * either: the decision is made on the server. No listing id, no category id, no seller, no account, no
 * token, no approval time, no view count, no moderation record and no rejection reason.
 *
 * **Submitting and archiving go to the listing routes**, because those move the same `listings` row and the
 * API's submitter is already service-aware. There is no second path to either of those moves, and no delete
 * anywhere.
 *
 * **The amount is displayed through the money package** and the currency's own minor unit, so nothing is
 * converted and no divisor is assumed. The price *input* stays an integer in minor units, for the reason the
 * forms module explains.
 *
 * **No optimistic write.** Every success refreshes the route, so the state the row then shows was read back
 * from the database rather than assumed from a click.
 */

/** Always present: what the row displays, and what a refusal says. */
export interface SellerServiceRowLabels {
  readonly status: string;
  readonly statusLabel: string;
  readonly category: string;
  readonly price: string;
  readonly noPrice: string;
  readonly negotiable: string;
  readonly pricing: string;
  readonly noPricing: string;
  readonly pricingFixed: string;
  readonly pricingCustom: string;
  readonly deliveryDays: string;
  readonly noDelivery: string;
  readonly revisions: string;
  readonly mediaCount: string;
  readonly noMedia: string;
  readonly awaitingReview: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly errorInvalid: string;
  readonly errorIncomplete: string;
  readonly errorNotEditable: string;
  readonly errorUnavailable: string;
}

/** Present only when this service may be edited. */
export interface SellerServiceEditLabels {
  readonly edit: string;
  readonly titleField: string;
  readonly description: string;
  readonly price: string;
  readonly priceHint: string;
  readonly negotiable: string;
  readonly language: string;
  readonly currency: string;
  readonly country: string;
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
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
}

/** Present only when this service may be submitted for review. */
export interface SellerServiceSubmitLabels {
  readonly submit: string;
  readonly submitting: string;
  readonly submitConfirm: string;
}

/** Present only when this service may be archived. */
export interface SellerServiceArchiveLabels {
  readonly archive: string;
  readonly archiving: string;
  readonly archiveConfirm: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';
const BUTTON_CLASS =
  'inline-flex items-center rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink-strong disabled:opacity-60';

const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];
const COUNTRIES: readonly string[] = ['EG'];

export function SellerServiceRow({
  service,
  labels,
  canMutate,
  edit,
  submit,
  archive,
  details,
}: {
  readonly service: RenderableService;
  readonly labels: SellerServiceRowLabels;
  readonly canMutate: boolean;
  readonly edit: SellerServiceEditLabels | null;
  readonly submit: SellerServiceSubmitLabels | null;
  readonly archive: SellerServiceArchiveLabels | null;
  /**
   * Where this service's structured details and tags live, and what the link says.
   *
   * Its own route rather than another disclosure here: the questions depend on the category and the answers are
   * their own reads, so putting them inline would mean two upstream calls per row on a page nobody had asked to
   * edit. A null group means the link is not offered, exactly as the action groups work.
   */
  readonly details: { readonly href: string; readonly label: string } | null;
}) {
  const router = useRouter();
  // The server already decided, by passing or withholding a label group. This is the same rule, asked again,
  // so a row cannot offer a control the state does not allow even if a label arrived.
  const actions = serviceActions(service.status, canMutate);
  const canEdit = edit !== null && actions.includes('edit');
  const canSubmit = submit !== null && actions.includes('submit');
  const canArchive = archive !== null && actions.includes('archive');

  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<ServiceUpdateValues>(() => initialServiceUpdateValues(service));
  const [confirming, setConfirming] = useState<'submit' | 'archive' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const starting = initialServiceUpdateValues(service);
  const amount = serviceAmount(service);

  function set(field: ServiceUpdateField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setNotice(null);
  }

  function report(kind: string): void {
    if (kind === 'invalid') setMessage(labels.errorInvalid);
    else if (kind === 'incomplete') setMessage(labels.errorIncomplete);
    else if (kind === 'not_editable') setMessage(labels.errorNotEditable);
    else setMessage(labels.errorUnavailable);
  }

  function pricingLabel(model: string | null): string {
    if (model === 'fixed') return labels.pricingFixed;
    if (model === 'custom') return labels.pricingCustom;
    return labels.noPricing;
  }

  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || edit === null) return;
    setMessage(null);
    setNotice(null);

    const built = buildServiceUpdate(values, starting);
    if (!built.ok) {
      setMessage(labels.errorInvalid);
      return;
    }
    if (!built.changed) {
      setNotice(edit.saved);
      return;
    }

    setPending(true);
    try {
      const outcome = await submitServiceUpdate(service.slug, built.body);
      if (outcome.kind === 'ok') {
        setNotice(edit.saved);
        setEditing(false);
        router.refresh();
        return;
      }
      report(outcome.kind);
    } finally {
      setPending(false);
    }
  }

  async function onConfirm(): Promise<void> {
    if (pending || confirming === null) return;
    setMessage(null);
    setNotice(null);
    setPending(true);
    try {
      // 6-F's transitions, on the same row. Nothing here assumes the new status.
      const outcome =
        confirming === 'submit'
          ? await submitListingForReview(service.slug)
          : await archiveListing(service.slug);
      setConfirming(null);
      if (outcome.kind === 'ok') {
        router.refresh();
        return;
      }
      report(outcome.kind);
    } finally {
      setPending(false);
    }
  }

  const pricingStated = values.pricingModel !== '';

  return (
    <li className="border-b border-hairline py-6">
      <h3 className="text-base font-semibold text-ink-strong">{service.title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{service.slug}</p>

      <dl className="mt-3 grid max-w-xl grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.status}</dt>
          <dd className="text-sm font-medium text-ink-strong">{labels.statusLabel}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.category}</dt>
          <dd className="text-sm text-ink-strong">{service.categorySlug}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.price}</dt>
          <dd className="text-sm text-ink-strong">
            {amount ?? labels.noPrice}
            {service.isNegotiable && amount !== null ? ` · ${labels.negotiable}` : ''}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.pricing}</dt>
          <dd className="text-sm text-ink-strong">{pricingLabel(service.pricingModel)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.deliveryDays}</dt>
          <dd className="text-sm text-ink-strong">
            {service.deliveryDays === null ? labels.noDelivery : String(service.deliveryDays)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.revisions}</dt>
          <dd className="text-sm text-ink-strong">
            {service.revisionsIncluded === null ? labels.noPricing : String(service.revisionsIncluded)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.mediaCount}</dt>
          <dd className="text-sm text-ink-strong">
            {service.mediaCount === 0 ? labels.noMedia : String(service.mediaCount)}
          </dd>
        </div>
      </dl>

      {service.status === 'pending_review' ? (
        <p role="status" className="mt-3 max-w-prose text-sm text-ink-muted">
          {labels.awaitingReview}
        </p>
      ) : null}

      {details === null ? null : (
        <p className="mt-3">
          <Link
            href={details.href}
            className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
          >
            {details.label}
          </Link>
        </p>
      )}

      {canEdit || canSubmit || canArchive ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canEdit && edit !== null ? (
            <button
              type="button"
              onClick={() => {
                setEditing((current) => !current);
                setMessage(null);
              }}
              aria-expanded={editing}
              className={BUTTON_CLASS}
            >
              {edit.edit}
            </button>
          ) : null}
          {canSubmit && submit !== null ? (
            <button
              type="button"
              onClick={() => {
                setConfirming('submit');
                setMessage(null);
              }}
              className={BUTTON_CLASS}
            >
              {submit.submit}
            </button>
          ) : null}
          {canArchive && archive !== null ? (
            <button
              type="button"
              onClick={() => {
                setConfirming('archive');
                setMessage(null);
              }}
              className={BUTTON_CLASS}
            >
              {archive.archive}
            </button>
          ) : null}
        </div>
      ) : null}

      {confirming !== null ? (
        <div role="group" className="mt-4 rounded-md border border-edge p-4">
          <p className="max-w-prose text-sm text-ink-strong">
            {confirming === 'submit' ? (submit?.submitConfirm ?? '') : (archive?.archiveConfirm ?? '')}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onConfirm()}
              disabled={pending}
              className="inline-flex items-center rounded-md bg-surface-ink px-3 py-1.5 text-sm font-medium text-on-ink disabled:opacity-60"
            >
              {pending
                ? confirming === 'submit'
                  ? (submit?.submitting ?? '')
                  : (archive?.archiving ?? '')
                : labels.confirm}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={pending}
              className={BUTTON_CLASS}
            >
              {labels.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {editing && canEdit && edit !== null ? (
        <form onSubmit={onSave} noValidate className="mt-5 max-w-xl space-y-4">
          <div>
            <label htmlFor={`svc-title-${service.slug}`} className={LABEL_CLASS}>
              {edit.titleField}
            </label>
            <input
              id={`svc-title-${service.slug}`}
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
            <label htmlFor={`svc-description-${service.slug}`} className={LABEL_CLASS}>
              {edit.description}
            </label>
            <textarea
              id={`svc-description-${service.slug}`}
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
            <label htmlFor={`svc-price-${service.slug}`} className={LABEL_CLASS}>
              {edit.price}
            </label>
            <input
              id={`svc-price-${service.slug}`}
              name="priceMinor"
              type="text"
              inputMode="numeric"
              value={values.priceMinor}
              onChange={(event) => set('priceMinor', event.target.value)}
              className={FIELD_CLASS}
            />
            <p className="mt-1 max-w-prose text-sm text-ink-muted">{edit.priceHint}</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              id={`svc-negotiable-${service.slug}`}
              name="isNegotiable"
              type="checkbox"
              checked={values.isNegotiable !== ''}
              onChange={(event) => set('isNegotiable', event.target.checked ? 'yes' : '')}
              className="h-4 w-4 rounded border-edge"
            />
            <label htmlFor={`svc-negotiable-${service.slug}`} className="text-sm text-ink-strong">
              {edit.negotiable}
            </label>
          </div>

          <div>
            <label htmlFor={`svc-language-${service.slug}`} className={LABEL_CLASS}>
              {edit.language}
            </label>
            <select
              id={`svc-language-${service.slug}`}
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
            <label htmlFor={`svc-currency-${service.slug}`} className={LABEL_CLASS}>
              {edit.currency}
            </label>
            <select
              id={`svc-currency-${service.slug}`}
              name="currencyCode"
              required
              value={values.currencyCode}
              onChange={(event) => set('currencyCode', event.target.value)}
              className={FIELD_CLASS}
            >
              {/* The service's own currency, read back from the database. No code is named in source:
                  owner decision E3 forbids a currency literal, and a service already knows its own. */}
              <option value={service.currencyCode}>{service.currencyCode}</option>
            </select>
          </div>

          <div>
            <label htmlFor={`svc-country-${service.slug}`} className={LABEL_CLASS}>
              {edit.country}
            </label>
            <select
              id={`svc-country-${service.slug}`}
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
            <label htmlFor={`svc-governorate-${service.slug}`} className={LABEL_CLASS}>
              {edit.governorate}
            </label>
            <input
              id={`svc-governorate-${service.slug}`}
              name="governorate"
              type="text"
              value={values.governorate}
              onChange={(event) => set('governorate', event.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          <div>
            <label htmlFor={`svc-city-${service.slug}`} className={LABEL_CLASS}>
              {edit.city}
            </label>
            <input
              id={`svc-city-${service.slug}`}
              name="city"
              type="text"
              value={values.city}
              onChange={(event) => set('city', event.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          <fieldset className="border-t border-hairline pt-4">
            <legend className="text-sm font-semibold text-ink-strong">{edit.pricing}</legend>

            <div className="mt-3">
              <label htmlFor={`svc-pricing-model-${service.slug}`} className={LABEL_CLASS}>
                {edit.pricingModel}
              </label>
              <select
                id={`svc-pricing-model-${service.slug}`}
                name="pricingModel"
                value={values.pricingModel}
                onChange={(event) => set('pricingModel', event.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">{edit.pricingUnset}</option>
                <option value="fixed">{edit.pricingFixed}</option>
                <option value="custom">{edit.pricingCustom}</option>
              </select>
              <p className="mt-1 max-w-prose text-sm text-ink-muted">{edit.pricingHint}</p>
            </div>

            {pricingStated ? (
              <>
                <div className="mt-4">
                  <label htmlFor={`svc-delivery-${service.slug}`} className={LABEL_CLASS}>
                    {edit.deliveryDays}
                  </label>
                  <input
                    id={`svc-delivery-${service.slug}`}
                    name="deliveryDays"
                    type="text"
                    inputMode="numeric"
                    required={values.pricingModel === 'fixed'}
                    value={values.deliveryDays}
                    onChange={(event) => set('deliveryDays', event.target.value)}
                    className={FIELD_CLASS}
                  />
                  <p className="mt-1 max-w-prose text-sm text-ink-muted">{edit.deliveryDaysHint}</p>
                </div>

                <div className="mt-4">
                  <label htmlFor={`svc-revisions-${service.slug}`} className={LABEL_CLASS}>
                    {edit.revisions}
                  </label>
                  <input
                    id={`svc-revisions-${service.slug}`}
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
                    id={`svc-brief-${service.slug}`}
                    name="requiresBrief"
                    type="checkbox"
                    checked={values.requiresBrief !== ''}
                    onChange={(event) => set('requiresBrief', event.target.checked ? 'yes' : '')}
                    className="h-4 w-4 rounded border-edge"
                  />
                  <label htmlFor={`svc-brief-${service.slug}`} className="text-sm text-ink-strong">
                    {edit.requiresBrief}
                  </label>
                </div>

                <div className="mt-4">
                  <label htmlFor={`svc-scope-${service.slug}`} className={LABEL_CLASS}>
                    {edit.scope}
                  </label>
                  <textarea
                    id={`svc-scope-${service.slug}`}
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

          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60"
          >
            {pending ? edit.saving : edit.save}
          </button>
        </form>
      ) : null}

      {message !== null ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {message}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="mt-3 text-sm text-ink-strong">
          {notice}
        </p>
      ) : null}
    </li>
  );
}
