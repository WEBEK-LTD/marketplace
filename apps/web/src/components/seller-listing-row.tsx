'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  archiveListing,
  buildListingUpdate,
  initialListingUpdateValues,
  listingActions,
  submitListingForReview,
  submitListingUpdate,
  type ListingUpdateField,
  type ListingUpdateValues,
  type RenderableListing,
} from './seller-listing-forms';

/**
 * One listing, and whatever S-8 lets its seller do with it (Phase 6-F).
 *
 * **What crosses the server/client boundary.** Copy, one {@link RenderableListing} — a narrowed render type
 * projected field by field on the server — and one label group per action this listing actually offers. No
 * listing id, no category id, no seller, no account, no token, no approval time, no view count, no
 * moderation record and no rejection reason: none of those is in the projection, so none can be in the RSC
 * payload.
 *
 * **Which controls exist is decided on the server, and the copy proves it.** The page passes `edit`,
 * `submit` and `archive` label groups, and a null group means that action is not offered — so a control this
 * listing's state does not allow has no text to render with, and its copy is not even in the payload. The
 * client checks the same question again through {@link listingActions}, which is the one place the rule is
 * written; the two agreeing is the point, and `app_private` refuses every one of these a third time anyway.
 * Controls that are not permitted are **absent**, never disabled: a disabled button is still in the DOM to
 * re-enable, and there is no delete to disable in the first place.
 *
 * **Both irreversible-feeling actions confirm first.** Submission ends the seller's ability to edit and
 * archival withdraws a listing from sale, so each asks in a sentence naming what will happen.
 *
 * **No optimistic write.** Every success refreshes the route, so the state the row then shows was read back
 * from the database rather than assumed from a click. A failure leaves the row exactly as the server last
 * described it, and an edit that failed keeps what was typed.
 */

/** Always present: what the row displays, and what a refusal says. */
export interface SellerListingRowLabels {
  readonly status: string;
  readonly statusLabel: string;
  readonly category: string;
  readonly price: string;
  readonly noPrice: string;
  readonly negotiable: string;
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

/** Present only when this listing may be edited. */
export interface SellerListingEditLabels {
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
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
}

/** Present only when this listing may be submitted for review. */
export interface SellerListingSubmitLabels {
  readonly submit: string;
  readonly submitting: string;
  readonly submitConfirm: string;
}

/** Present only when this listing may be archived. */
export interface SellerListingArchiveLabels {
  readonly archive: string;
  readonly archiving: string;
  readonly archiveConfirm: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-ink-strong';
const BUTTON_CLASS =
  'inline-flex items-center rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink-strong disabled:opacity-60';

/** The two interface locales, as 6-C and 6-D render them. `public.locales` remains the authority. */
const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

/** Egypt is the only marketplace-enabled country in V1 (D17). No currency is named here — see E3. */
const COUNTRIES: readonly string[] = ['EG'];

export function SellerListingRow({
  listing,
  labels,
  canMutate,
  edit,
  submit,
  archive,
  details,
}: {
  readonly listing: RenderableListing;
  readonly labels: SellerListingRowLabels;
  readonly canMutate: boolean;
  readonly edit: SellerListingEditLabels | null;
  readonly submit: SellerListingSubmitLabels | null;
  readonly archive: SellerListingArchiveLabels | null;
  /**
   * Where this listing's structured details and tags live, and what the link says.
   *
   * Its own route rather than another disclosure here: the questions depend on the category and the answers are
   * their own reads, so putting them inline would mean two upstream calls per row on a page nobody had asked to
   * edit. A null group means the link is not offered, exactly as the action groups work.
   */
  readonly details: { readonly href: string; readonly label: string } | null;
}) {
  const router = useRouter();
  // The server already decided, by passing or withholding a label group. This is the same rule, written
  // once and asked again, so a row cannot offer a control the state does not allow even if a label arrived.
  const actions = listingActions(listing.status, canMutate);
  const canEdit = edit !== null && actions.includes('edit');
  const canSubmit = submit !== null && actions.includes('submit');
  const canArchive = archive !== null && actions.includes('archive');

  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<ListingUpdateValues>(() => initialListingUpdateValues(listing));
  const [confirming, setConfirming] = useState<'submit' | 'archive' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const starting = initialListingUpdateValues(listing);

  function set(field: ListingUpdateField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setNotice(null);
  }

  function report(kind: string): void {
    if (kind === 'invalid') setMessage(labels.errorInvalid);
    else if (kind === 'incomplete') setMessage(labels.errorIncomplete);
    else if (kind === 'not_editable') setMessage(labels.errorNotEditable);
    else setMessage(labels.errorUnavailable);
  }

  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || edit === null) return;
    setMessage(null);
    setNotice(null);

    const built = buildListingUpdate(values, starting);
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
      const outcome = await submitListingUpdate(listing.slug, built.body);
      if (outcome.kind === 'ok') {
        setNotice(edit.saved);
        setEditing(false);
        // The page re-reads from the database; nothing here assumes the edit landed as typed.
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
      const outcome =
        confirming === 'submit'
          ? await submitListingForReview(listing.slug)
          : await archiveListing(listing.slug);
      setConfirming(null);
      if (outcome.kind === 'ok') {
        // The new status is read back rather than assumed from a click.
        router.refresh();
        return;
      }
      report(outcome.kind);
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="border-b border-hairline py-6">
      <h3 className="text-base font-semibold text-ink-strong">{listing.title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{listing.slug}</p>

      <dl className="mt-3 grid max-w-xl grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.status}</dt>
          <dd className="text-sm font-medium text-ink-strong">{labels.statusLabel}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.category}</dt>
          <dd className="text-sm text-ink-strong">{listing.categorySlug}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.price}</dt>
          <dd className="text-sm text-ink-strong">
            {listing.priceMinor === null
              ? labels.noPrice
              : `${String(listing.priceMinor)} ${listing.currencyCode}`}
            {listing.isNegotiable ? ` · ${labels.negotiable}` : ''}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-sm text-ink-muted">{labels.mediaCount}</dt>
          <dd className="text-sm text-ink-strong">
            {listing.mediaCount === 0 ? labels.noMedia : String(listing.mediaCount)}
          </dd>
        </div>
      </dl>

      {listing.status === 'pending_review' ? (
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
        // The sentence says what will happen, and the action needs a second, deliberate press.
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
            <label htmlFor={`edit-title-${listing.slug}`} className={LABEL_CLASS}>
              {edit.titleField}
            </label>
            <input
              id={`edit-title-${listing.slug}`}
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
            <label htmlFor={`edit-description-${listing.slug}`} className={LABEL_CLASS}>
              {edit.description}
            </label>
            <textarea
              id={`edit-description-${listing.slug}`}
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
            <label htmlFor={`edit-price-${listing.slug}`} className={LABEL_CLASS}>
              {edit.price}
            </label>
            <input
              id={`edit-price-${listing.slug}`}
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
              id={`edit-negotiable-${listing.slug}`}
              name="isNegotiable"
              type="checkbox"
              checked={values.isNegotiable !== ''}
              onChange={(event) => set('isNegotiable', event.target.checked ? 'yes' : '')}
              className="h-4 w-4 rounded border-edge"
            />
            <label htmlFor={`edit-negotiable-${listing.slug}`} className="text-sm text-ink-strong">
              {edit.negotiable}
            </label>
          </div>

          <div>
            <label htmlFor={`edit-language-${listing.slug}`} className={LABEL_CLASS}>
              {edit.language}
            </label>
            <select
              id={`edit-language-${listing.slug}`}
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
            <label htmlFor={`edit-currency-${listing.slug}`} className={LABEL_CLASS}>
              {edit.currency}
            </label>
            <select
              id={`edit-currency-${listing.slug}`}
              name="currencyCode"
              required
              value={values.currencyCode}
              onChange={(event) => set('currencyCode', event.target.value)}
              className={FIELD_CLASS}
            >
              {/* The listing's own currency, read back from the database. No code is named in source:
                  owner decision E3 forbids a currency literal, and a listing already knows its own. */}
              <option value={listing.currencyCode}>{listing.currencyCode}</option>
            </select>
          </div>

          <div>
            <label htmlFor={`edit-country-${listing.slug}`} className={LABEL_CLASS}>
              {edit.country}
            </label>
            <select
              id={`edit-country-${listing.slug}`}
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
            <label htmlFor={`edit-governorate-${listing.slug}`} className={LABEL_CLASS}>
              {edit.governorate}
            </label>
            <input
              id={`edit-governorate-${listing.slug}`}
              name="governorate"
              type="text"
              value={values.governorate}
              onChange={(event) => set('governorate', event.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          <div>
            <label htmlFor={`edit-city-${listing.slug}`} className={LABEL_CLASS}>
              {edit.city}
            </label>
            <input
              id={`edit-city-${listing.slug}`}
              name="city"
              type="text"
              value={values.city}
              onChange={(event) => set('city', event.target.value)}
              className={FIELD_CLASS}
            />
          </div>

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
