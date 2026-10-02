import type { PublicSellerProfile, SellerAvailability } from '@repo/contracts';

/**
 * The public seller profile (Phase 4-E).
 *
 * A profile and nothing else in V1: a name, the seller's own words, and the city they trade from. No
 * listings, no services, no ratings, no review count, no statistics, no verification badge and no contact
 * details — every one of those was explicitly excluded, and several of them never leave the database.
 *
 * Direction is never hard-coded. Spacing uses logical properties, so the same markup reads correctly in
 * English and in Arabic with nothing but `dir` changing.
 */

export interface SellerLabels {
  readonly unavailable: string;
  readonly noDescription: string;
}

export function SellerProfileView({
  seller,
  availability,
  labels,
}: {
  readonly seller: PublicSellerProfile;
  readonly availability: SellerAvailability;
  readonly labels: SellerLabels;
}) {
  const unavailable = availability === 'unavailable';

  return (
    <article>
      {unavailable ? (
        <p
          role="status"
          className="rounded-lg border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-900"
        >
          {labels.unavailable}
        </p>
      ) : null}

      <h1 className="mt-4 text-3xl font-semibold text-neutral-900">{seller.displayName}</h1>
      {seller.city === null ? null : <p className="mt-1 text-neutral-600">{seller.city}</p>}

      {seller.bio === null ? (
        <p className="mt-6 max-w-prose text-neutral-600">{labels.noDescription}</p>
      ) : (
        // The bio is seller-written and never translated (D7), so it carries the language it was
        // written in — a profile read in Arabic may hold an English bio, and a screen reader should
        // switch voice for it rather than read it in the page's language.
        <p
          {...(seller.contentLanguage === null ? {} : { lang: seller.contentLanguage })}
          className="mt-6 max-w-prose whitespace-pre-line text-neutral-800"
        >
          {seller.bio}
        </p>
      )}
    </article>
  );
}
