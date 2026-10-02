import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Address, FavoriteItem, SavedSearch } from '@repo/contracts';
import { ListingPrice, type ListingPriceLabels } from './listing-price';
import { RemoveFavorite } from './account-actions';

/**
 * The server-rendered parts of the buyer account surfaces (Phase 7-E).
 *
 * **What crosses into the client, and what does not.** Only the small action buttons are client
 * components, and their props are one identifier and a handful of words each. Everything a person reads
 * — a price, an address, the name of a saved search — is rendered here, on the server, so it is markup
 * in the page rather than data in the RSC payload.
 *
 * Every list has the same four states and they are all real: a skeleton while it loads, an empty state
 * that says what the list is for, an error state whose recovery is a link back to the same view, and the
 * list itself. None of them is a placeholder panel.
 *
 * Layout is written in logical properties — `ms-`, `me-`, `text-start` — so Arabic mirrors without a
 * second stylesheet, and every list is a real `<ul>` with an accessible name.
 */

const CARD_CLASS = 'rounded-lg border border-neutral-200 p-4';

/* ------------------------------------------------------------------------------------------------ */
/* Shared states                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export function AccountSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="mt-6 space-y-3" role="status" aria-label={label} aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-20 animate-pulse rounded-lg bg-neutral-100" />
      ))}
    </div>
  );
}

export function AccountEmpty({ title, hint }: { readonly title: string; readonly hint: string }) {
  return (
    <div className={`mt-6 ${CARD_CLASS} text-center`}>
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mt-2 text-sm text-neutral-600">{hint}</p>
    </div>
  );
}

export function AccountError({
  title,
  retry,
  href,
}: {
  readonly title: string;
  readonly retry: string;
  readonly href: string;
}) {
  return (
    <div className={`mt-6 ${CARD_CLASS}`} role="alert">
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <Link href={href} className="mt-3 inline-block text-sm underline underline-offset-4">
        {retry}
      </Link>
    </div>
  );
}

/** A labelled read-only fact. Used by the profile and security surfaces. */
export function AccountFact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-100 py-3">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-sm font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Favorites                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface FavoriteCopy {
  readonly listLabel: string;
  readonly unavailable: string;
  readonly unavailableHint: string;
  readonly open: string;
  readonly remove: string;
  readonly working: string;
  readonly failed: string;
  readonly price: ListingPriceLabels;
}

/**
 * The saved listings.
 *
 * A favorite whose listing is no longer visible is still shown — it is the person's own saved row, and
 * removing it from the screen would leave them unable to tidy it up. It carries no link and no price,
 * because the reader sent neither.
 */
export function FavoriteList({
  items,
  copy,
  localePrefix,
}: {
  readonly items: readonly FavoriteItem[];
  readonly copy: FavoriteCopy;
  readonly localePrefix: string;
}) {
  return (
    <ul className="mt-6 space-y-3" aria-label={copy.listLabel}>
      {items.map((item) => (
        <li key={item.listingId} className={CARD_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {item.listing === null ? (
                <>
                  <p className="text-base font-medium text-neutral-500">{copy.unavailable}</p>
                  <p className="mt-1 text-sm text-neutral-500">{copy.unavailableHint}</p>
                </>
              ) : (
                <>
                  <Link
                    href={`${localePrefix}/listing/${item.listing.slug}`}
                    className="text-base font-medium text-neutral-900 underline underline-offset-4"
                  >
                    {item.listing.title}
                  </Link>
                  {/* ListingPrice renders its own paragraph, so the city sits beside it rather than
                      inside it: a <p> may not contain another <p>. */}
                  <ListingPrice
                    priceMinor={item.listing.priceMinor}
                    currencyCode={item.listing.currencyCode}
                    currencyMinorUnit={item.listing.currencyMinorUnit}
                    isNegotiable={item.listing.isNegotiable}
                    labels={copy.price}
                  />
                  {item.listing.city !== null && (
                    <p className="mt-1 text-sm text-neutral-600">{item.listing.city}</p>
                  )}
                </>
              )}
            </div>
            <RemoveFavorite
              listingId={item.listingId}
              copy={{ remove: copy.remove, working: copy.working, failed: copy.failed }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Saved searches                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface SavedSearchCopy {
  readonly listLabel: string;
  readonly notifyOn: string;
  readonly notifyOff: string;
  readonly never: string;
  readonly lastMatched: string;
  readonly open: string;
}

/**
 * One saved search, read-only.
 *
 * `lastMatchedAt` is shown because it is the person's own data, and it says "never" for everything in
 * this project: nothing computes a match. The surface reports that honestly rather than hiding the field
 * or implying a schedule.
 */
export function SavedSearchSummary({
  search,
  copy,
  localePrefix,
}: {
  readonly search: SavedSearch;
  readonly copy: SavedSearchCopy;
  readonly localePrefix: string;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search.query)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(key, String(value));
    }
  }

  return (
    <>
      <p className="text-base font-medium text-neutral-900">{search.name}</p>
      <p className="mt-1 text-sm text-neutral-600">
        {search.notify ? copy.notifyOn : copy.notifyOff}
        <span className="ms-3">
          {copy.lastMatched}: {search.lastMatchedAt === null ? copy.never : search.lastMatchedAt.slice(0, 10)}
        </span>
      </p>
      {query.size > 0 && (
        <Link
          href={`${localePrefix}/search?${query.toString()}`}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {copy.open}
        </Link>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Addresses                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface AddressCopy {
  readonly listLabel: string;
  readonly defaultShipping: string;
  readonly defaultBilling: string;
  readonly purpose: Record<string, string>;
}

/** One address, rendered as an address. */
export function AddressSummary({
  address,
  copy,
}: {
  readonly address: Address;
  readonly copy: AddressCopy;
}) {
  const parts = [
    address.streetAddress,
    address.building,
    address.apartment,
    address.district,
    address.city,
    address.governorate,
    address.postalCode,
    address.countryCode,
  ].filter((part): part is string => part !== null && part !== '');

  return (
    <>
      <p className="text-base font-medium text-neutral-900">
        {address.label ?? address.recipientName}
        {address.isDefaultShipping && (
          <span className="ms-2 rounded bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-700">
            {copy.defaultShipping}
          </span>
        )}
        {address.isDefaultBilling && (
          <span className="ms-2 rounded bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-700">
            {copy.defaultBilling}
          </span>
        )}
      </p>
      <address className="mt-1 text-sm not-italic text-neutral-600">
        {address.recipientName}
        <br />
        {parts.join(', ')}
        <br />
        {address.phoneE164}
      </address>
      <p className="mt-1 text-xs text-neutral-500">{copy.purpose[address.purpose] ?? address.purpose}</p>
    </>
  );
}
